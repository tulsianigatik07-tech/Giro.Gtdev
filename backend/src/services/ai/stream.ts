// Stream utilities: convert async iterable to collected text and handle partial failures.

export async function collectStream(
  stream: AsyncIterable<string>,
): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

export async function* safeStream(
  stream: AsyncIterable<string>,
): AsyncGenerator<string> {
  try {
    for await (const chunk of stream) {
      yield chunk;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream interrupted";
    yield `\n\n[Error: ${message}]`;
  }
}
