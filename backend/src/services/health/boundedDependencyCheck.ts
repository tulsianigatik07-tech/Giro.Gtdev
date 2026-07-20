export async function runBoundedDependencyCheck(
  check: () => void | Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Dependency check timed out.")),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
