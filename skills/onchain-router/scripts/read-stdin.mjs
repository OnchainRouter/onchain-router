export async function readStdin(maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) throw new Error('stdin exceeds the local input limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
