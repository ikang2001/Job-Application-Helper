export const MAX_JD_LENGTH = 16_000;

export type JobMetadataField =
  | 'companyName'
  | 'jobTitle'
  | 'jobId'
  | 'location'
  | 'employmentType'
  | 'jobDescription';

export type JobMetadataSource = 'json-ld' | 'meta' | 'dom' | 'url' | 'title';

export interface ExtractedJobField {
  value: string;
  source: JobMetadataSource;
  confidence: number;
}

export interface JobPageExtraction {
  companyName?: ExtractedJobField;
  jobTitle?: ExtractedJobField;
  jobId?: ExtractedJobField;
  location?: ExtractedJobField;
  employmentType?: ExtractedJobField;
  jobDescription?: ExtractedJobField;
}

export interface JobDescriptionSnapshot {
  text: string;
  capturedAt: string;
  sourceUrl: string;
  contentHash: string;
  truncated: boolean;
}

export interface JobFieldProvenance {
  source: JobMetadataSource;
  confidence: number;
}

export type JobExtractionProvenance = Partial<Record<JobMetadataField, JobFieldProvenance>>;

export interface ExtractedApplicationPageMetadata {
  companyName: string;
  jobTitle?: string;
  jobId?: string;
  location?: string;
  employmentType?: string;
  sourceSite: string;
  sourceUrl: string;
  pageTitle?: string;
  jdSnapshot?: JobDescriptionSnapshot;
  extractionProvenance?: JobExtractionProvenance;
}

export interface JobPageContext {
  document: Document;
  url: string;
}

export interface JobPageExtractor {
  match(context: JobPageContext): boolean;
  extract(context: JobPageContext): JobPageExtraction;
}

export type Sha256Digest = (text: string) => Promise<string>;
