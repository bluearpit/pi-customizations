export function targetIdentity(target: { _targetId?: unknown }): string;
export function trackPopup(info: { type: string; targetId: string; openerId?: string }, owned: Set<string | undefined>, initial: Set<string>, primaryId: string): boolean;
