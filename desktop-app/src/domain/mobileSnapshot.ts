import type {
  ApplicationRecord,
  ApplicationRecordStatus,
  RecruitmentSchedule,
} from '../../../src/shared/types.ts';
import type { CareerFair } from '../shared/contracts.ts';

export const MOBILE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface MobileSnapshotApplication {
  id: string;
  companyName: string;
  jobTitle: string;
  sourceSite: string;
  sourceUrl: string;
  status: ApplicationRecordStatus;
  notes: string;
  appliedAt: string;
  location: string;
  recruitmentSchedule?: RecruitmentSchedule;
  createdAt: string;
  updatedAt: string;
}

export interface MobileSnapshotCareerFair {
  id: string;
  name: string;
  status: CareerFair['status'];
  startsAt: string;
  endsAt: string;
  mode: CareerFair['mode'];
  location: string;
  organizer: string;
  registrationDeadline: string;
  eventUrl: string;
  targetCompanies: string;
  targetRoles: string;
  preparation: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface MobileSnapshot {
  schemaVersion: 1;
  revision: number;
  generatedAt: string;
  applications: MobileSnapshotApplication[];
  careerFairs: MobileSnapshotCareerFair[];
}

export function createMobileSnapshot(
  records: readonly ApplicationRecord[],
  careerFairs: readonly CareerFair[],
  revision: number,
  generatedAt = new Date().toISOString(),
): MobileSnapshot {
  return {
    schemaVersion: MOBILE_SNAPSHOT_SCHEMA_VERSION,
    revision,
    generatedAt,
    applications: records.map(record => ({
      id: record.id,
      companyName: record.companyName,
      jobTitle: record.jobTitle,
      sourceSite: record.sourceSite,
      sourceUrl: record.sourceUrl,
      status: record.status,
      notes: record.notes,
      appliedAt: record.appliedAt,
      location: record.location,
      recruitmentSchedule: cloneSchedule(record.recruitmentSchedule),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })),
    careerFairs: careerFairs.map(fair => ({
      id: fair.id,
      name: fair.name,
      status: fair.status,
      startsAt: fair.startsAt,
      endsAt: fair.endsAt,
      mode: fair.mode,
      location: fair.location,
      organizer: fair.organizer,
      registrationDeadline: fair.registrationDeadline,
      eventUrl: fair.eventUrl,
      targetCompanies: fair.targetCompanies,
      targetRoles: fair.targetRoles,
      preparation: fair.preparation,
      notes: fair.notes,
      createdAt: fair.createdAt,
      updatedAt: fair.updatedAt,
    })),
  };
}

function cloneSchedule(schedule: RecruitmentSchedule | undefined): RecruitmentSchedule | undefined {
  if (!schedule) return undefined;
  return structuredClone(schedule);
}
