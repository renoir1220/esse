export type ComposerKey = {
  key: string;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
};

export function shouldSubmitComposerKey(event: ComposerKey): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.repeat && !event.isComposing;
}
