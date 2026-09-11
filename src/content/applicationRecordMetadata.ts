import { extractJobPage } from './job-extractors/registry.ts';
import { createJobDescriptionSnapshot } from './job-extractors/snapshot.ts';
import { isLikelyJobDetailUrl, isSubmissionFlowUrl } from '../shared/jobMetadata.ts';
import type {
  ExtractedApplicationPageMetadata,
  JobExtractionProvenance,
  Sha256Digest,
} from './job-extractors/types.ts';

interface ApplicationMetadataExtractionOptions {
  capturedAt?: string;
  digest?: Sha256Digest;
}

export async function extractApplicationPageMetadata(
  doc: Document,
  url: string,
  options: ApplicationMetadataExtractionOptions = {},
): Promise<ExtractedApplicationPageMetadata> {
  const parsedUrl = new URL(url);
  const extraction = extractJobPage({ document: doc, url: parsedUrl.toString() });
  const sourceUrl = resolveJobSourceUrl(doc, parsedUrl);
  const sourceSite = new URL(sourceUrl).host;
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const jdSnapshot = extraction.jobDescription
    ? await createJobDescriptionSnapshot(
      extraction.jobDescription.value,
      sourceUrl,
      capturedAt,
      options.digest,
    )
    : undefined;

  return {
    companyName: extraction.companyName?.value ?? '',
    jobTitle: extraction.jobTitle?.value,
    jobId: extraction.jobId?.value,
    location: extraction.location?.value,
    employmentType: extraction.employmentType?.value,
    sourceSite,
    sourceUrl,
    pageTitle: doc.title.trim(),
    jdSnapshot,
    extractionProvenance: toProvenance(extraction),
  };
}

function resolveJobSourceUrl(doc: Document, currentUrl: URL): string {
  const referrer = typeof doc.referrer === 'string' ? doc.referrer.trim() : '';
  if (isSubmissionFlowUrl(currentUrl.toString()) && isLikelyJobDetailUrl(referrer)) {
    return new URL(referrer).toString();
  }
  return currentUrl.toString();
}

function toProvenance(
  extraction: ReturnType<typeof extractJobPage>,
): JobExtractionProvenance | undefined {
  const provenance = Object.fromEntries(
    Object.entries(extraction).map(([field, value]) => [
      field,
      value ? { source: value.source, confidence: value.confidence } : undefined,
    ]).filter(([, value]) => value !== undefined),
  ) as JobExtractionProvenance;

  return Object.keys(provenance).length > 0 ? provenance : undefined;
}
