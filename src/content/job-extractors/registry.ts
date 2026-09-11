import { genericJobPageExtractor } from './generic.ts';
import type { JobPageContext, JobPageExtraction, JobPageExtractor } from './types.ts';

const EXTRACTORS: readonly JobPageExtractor[] = [genericJobPageExtractor];

export function extractJobPage(context: JobPageContext): JobPageExtraction {
  const extractor = EXTRACTORS.find(candidate => candidate.match(context));
  return extractor?.extract(context) ?? {};
}

export function getRegisteredJobExtractors(): readonly JobPageExtractor[] {
  return EXTRACTORS;
}
