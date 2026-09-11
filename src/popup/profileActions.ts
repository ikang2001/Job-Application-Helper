import type { MessageResponse, ResumeProfileSummary, UserProfile } from '../shared/types';

export function isPopupInteractionDisabled(states: {
  switching: boolean;
  filling: boolean;
  aiScanning: boolean;
  startingAIRegion: boolean;
}): boolean {
  return states.switching || states.filling || states.aiScanning || states.startingAIRegion;
}

export function claimPopupSwitch(pending: { current: boolean }): boolean {
  if (pending.current) return false;
  pending.current = true;
  return true;
}

export interface PopupRequestGate {
  begin: () => number;
  isCurrent: (token: number) => boolean;
  invalidate: () => void;
  unmount: () => void;
}

export function createPopupRequestGate(): PopupRequestGate {
  let generation = 0;
  let mounted = true;
  return {
    begin: () => ++generation,
    isCurrent: token => mounted && token === generation,
    invalidate: () => { generation += 1; },
    unmount: () => { mounted = false; generation += 1; },
  };
}

interface InitialLoadDependencies {
  loadSummary: () => Promise<ResumeProfileSummary>;
  loadProfile: () => Promise<UserProfile>;
  commitSummary: (summary: ResumeProfileSummary) => void;
  commitProfile: (profile: UserProfile) => void;
  showError: (error: string) => void;
  isCurrent: () => boolean;
}

export async function executePopupInitialLoad(dependencies: InitialLoadDependencies): Promise<void> {
  const [summary, profile] = await Promise.allSettled([dependencies.loadSummary(), dependencies.loadProfile()]);
  if (!dependencies.isCurrent()) return;
  const errors: string[] = [];
  if (summary.status === 'fulfilled') dependencies.commitSummary(summary.value);
  else errors.push('简历列表加载失败');
  if (profile.status === 'fulfilled') dependencies.commitProfile(profile.value);
  else errors.push('个人资料加载失败');
  if (errors.length) dependencies.showError(errors.join('；'));
}

interface SwitchDependencies {
  switchProfile: (targetId: string) => Promise<MessageResponse<ResumeProfileSummary>>;
  loadSummary: () => Promise<ResumeProfileSummary>;
  loadProfile: () => Promise<UserProfile>;
  commitSummary: (summary: ResumeProfileSummary) => void;
  commitProfile: (profile: UserProfile) => void;
  rollback: (id: string) => void;
  showError: (error: string) => void;
  isCurrent: () => boolean;
}

export async function executePopupProfileSwitch(
  targetId: string,
  previousId: string,
  dependencies: SwitchDependencies,
): Promise<void> {
  let response: MessageResponse<ResumeProfileSummary>;
  try {
    response = await dependencies.switchProfile(targetId);
  } catch (error) {
    if (!dependencies.isCurrent()) return;
    dependencies.rollback(previousId);
    dependencies.showError(error instanceof Error ? error.message : '切换简历失败，请稍后重试');
    return;
  }
  if (!dependencies.isCurrent()) return;
  if (!response.success) {
    dependencies.rollback(previousId);
    dependencies.showError(response.error || '切换简历失败，请稍后重试');
    return;
  }

  // SWITCH 已成功，从此不再回滚。先保留 mutation 返回的权威 active id，再独立刷新两份数据。
  const authoritativeActiveId = response.data?.activeProfileId || targetId;
  if (response.data) dependencies.commitSummary(response.data);
  const [summary, profile] = await Promise.allSettled([dependencies.loadSummary(), dependencies.loadProfile()]);
  if (!dependencies.isCurrent()) return;
  const errors: string[] = [];
  if (summary.status === 'fulfilled') {
    dependencies.commitSummary({ ...summary.value, activeProfileId: authoritativeActiveId });
  } else {
    errors.push('切换成功，但简历列表刷新失败');
  }
  if (profile.status === 'fulfilled') dependencies.commitProfile(profile.value);
  else errors.push('切换成功，但资料刷新失败');
  if (errors.length) dependencies.showError(errors.join('；'));
}
