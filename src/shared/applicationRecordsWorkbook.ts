import JSZip from 'jszip';
import {
  APPLICATION_RECORD_TABLE_CSV_HEADERS,
  normalizeApplicationRecord,
} from './applicationRecords.ts';
import type { ApplicationRecord } from './types.ts';

export const APPLICATION_RECORDS_XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validHttpUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

function columnName(index: number): string {
  let current = index + 1;
  let result = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function inlineStringCell(reference: string, value: string, styleIndex: number): string {
  return `<c r="${reference}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function worksheetXml(records: readonly ApplicationRecord[]): {
  sheet: string;
  relationships: string;
} {
  const normalizedRecords = records.map(normalizeApplicationRecord);
  const headerCells = APPLICATION_RECORD_TABLE_CSV_HEADERS
    .map((header, index) => inlineStringCell(`${columnName(index)}1`, header, 2))
    .join('');
  const hyperlinks: string[] = [];
  const relationships: string[] = [];
  const dataRows = normalizedRecords.map((record, index) => {
    const rowNumber = index + 2;
    const values = [
      record.companyName,
      record.jobTitle,
      record.sourceUrl,
      record.status,
      record.appliedAt,
      record.location,
    ];
    const url = validHttpUrl(record.sourceUrl);
    const cells = values.map((value, columnIndex) => {
      const isLinkCell = columnIndex === 2 && Boolean(url);
      return inlineStringCell(`${columnName(columnIndex)}${rowNumber}`, value, isLinkCell ? 1 : 0);
    }).join('');
    if (url) {
      const relationshipId = `rId${relationships.length + 1}`;
      hyperlinks.push(`<hyperlink ref="C${rowNumber}" r:id="${relationshipId}"/>`);
      relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`);
    }
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  const lastRow = Math.max(normalizedRecords.length + 1, 1);
  const hyperlinkBlock = hyperlinks.length > 0 ? `<hyperlinks>${hyperlinks.join('')}</hyperlinks>` : '';

  return {
    sheet: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:F${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/><col min="3" max="3" width="70" customWidth="1"/><col min="4" max="4" width="14" customWidth="1"/><col min="5" max="5" width="16" customWidth="1"/><col min="6" max="6" width="20" customWidth="1"/></cols>
  <sheetData><row r="1" ht="24" customHeight="1">${headerCells}</row>${dataRows}</sheetData>
  ${hyperlinkBlock}
  <autoFilter ref="A1:F${lastRow}"/>
</worksheet>`,
    relationships: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`,
  };
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELATIONSHIPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="投递记录" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELATIONSHIPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/><u/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9E1F2"/></left><right style="thin"><color rgb="FFD9E1F2"/></right><top style="thin"><color rgb="FFD9E1F2"/></top><bottom style="thin"><color rgb="FFD9E1F2"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function buildApplicationRecordsWorkbookFilename(date = new Date()): string {
  const compact = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `application-records-${compact}.xlsx`;
}

export async function buildApplicationRecordsWorkbook(
  records: readonly ApplicationRecord[],
  createdAt = new Date(),
): Promise<Blob> {
  const worksheet = worksheetXml(records);
  const timestamp = createdAt.toISOString();
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELATIONSHIPS_XML);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>秋招网申助手</Application></Properties>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>秋招网申助手</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`);
  zip.file('xl/workbook.xml', WORKBOOK_XML);
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELATIONSHIPS_XML);
  zip.file('xl/styles.xml', STYLES_XML);
  zip.file('xl/worksheets/sheet1.xml', worksheet.sheet);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', worksheet.relationships);
  return await zip.generateAsync({
    type: 'blob',
    mimeType: APPLICATION_RECORDS_XLSX_MIME_TYPE,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
