import type { Message, MessageResponse, ResumeProfileSummary } from '../shared/types';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

type SendMessage = (message: Message) => Promise<MessageResponse<ResumeProfileSummary>>;

export async function runGuardedProfileChange(
  dirty: boolean,
  save: () => Promise<boolean>,
  action: () => Promise<boolean | void>,
  choose: () => Promise<UnsavedChoice>,
): Promise<boolean> {
  if (dirty) {
    const choice = await choose();
    if (choice === 'cancel') return false;
    if (choice === 'save' && !await save()) return false;
  }
  return await action() !== false;
}

export async function executeGuardedProfileOperation(
  message: Message,
  dependencies: {
    dirty: boolean;
    save: () => Promise<boolean>;
    choose: () => Promise<UnsavedChoice>;
    send: SendMessage;
  },
): Promise<MessageResponse<ResumeProfileSummary> | null> {
  let response: MessageResponse<ResumeProfileSummary> | null = null;
  await runGuardedProfileChange(dependencies.dirty, dependencies.save, async () => {
    response = await dependencies.send(message);
    return response.success;
  }, dependencies.choose);
  return response;
}
