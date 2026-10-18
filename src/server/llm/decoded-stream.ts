/** Decode chunks without flushing an incomplete trailing UTF-8 sequence. */
export async function* readDecodedChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      yield decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}
