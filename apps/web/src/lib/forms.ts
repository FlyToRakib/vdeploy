/** The message to show for a failed API or auth-client call, never a raw status code. */
export function messageOf(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof record.error?.message === 'string') return record.error.message;
    if (typeof record.message === 'string' && record.message) return record.message;
  }
  return fallback;
}

/** A text field from submitted form data; files and missing fields read as ''. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
