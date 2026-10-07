export function createGeminiStreamPipeline() {
  let hasToolCalls = false;
  let inThought = false;
  let initialThoughtFinished = false;
  let contentBuffer = "";
  let sseLineBuffer = "";
  let emittedContentLength = 0;
  let strippedThoughtBuffer = "";

  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();

  function filterThoughts(content) {
    if (initialThoughtFinished) return content;

    let str = contentBuffer + content;
    contentBuffer = "";

    if (inThought) {
      const closeMatch = str.match(/<\/(thought|thinking|think)>/i);
      if (closeMatch) {
        inThought = false;
        initialThoughtFinished = true;
        strippedThoughtBuffer += str.slice(0, closeMatch.index);
        return str.slice(closeMatch.index + closeMatch[0].length);
      }

      const lastLt = str.lastIndexOf("<");
      if (lastLt !== -1 && !str.slice(lastLt).includes(">")) {
        contentBuffer = str.slice(lastLt);
        strippedThoughtBuffer += str.slice(0, lastLt);
        return "";
      }
      strippedThoughtBuffer += str;
      return "";
    }

    const openMatch = str.match(/<(thought|thinking|think)>/i);
    if (openMatch) {
      inThought = true;
      const preText = str.slice(0, openMatch.index);
      const rest = str.slice(openMatch.index + openMatch[0].length);

      const immediateClose = rest.match(/<\/(thought|thinking|think)>/i);
      if (immediateClose) {
        inThought = false;
        initialThoughtFinished = true;
        strippedThoughtBuffer += rest.slice(0, immediateClose.index);
        return preText + rest.slice(immediateClose.index + immediateClose[0].length);
      }
      return preText;
    }

    if (str.trim().length > 0) {
      initialThoughtFinished = true;
    }
    return str;
  }

  return new TransformStream({
    transform(chunk, controller) {
      sseLineBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseLineBuffer.split("\n");
      sseLineBuffer = lines.pop();

      for (let line of lines) {
        if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
          if (initialThoughtFinished && !hasToolCalls && !line.includes('"tool_calls"')) {
            emittedContentLength += line.length;
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }

          try {
            const json = JSON.parse(line.slice(6));
            const choice = json.choices?.[0];

            if (choice) {
              if (choice.delta?.tool_calls) {
                hasToolCalls = true;
                strippedThoughtBuffer = "";
              }

              if (hasToolCalls && choice.finish_reason && choice.finish_reason.toLowerCase() === "stop") {
                choice.finish_reason = "tool_calls";
              }

              if (choice.delta && typeof choice.delta.content === "string") {
                const filtered = filterThoughts(choice.delta.content);
                choice.delta.content = filtered;
                if (filtered.length > 0) {
                  emittedContentLength += filtered.length;
                  // Как только пошел реальный полезный ответ, мысли больше не нужны - освобождаем память
                  if (strippedThoughtBuffer) {
                    strippedThoughtBuffer = "";
                  }
                }
              }
            }
            line = "data: " + JSON.stringify(json);
          } catch {
            // Если чанк не JSON, оставляем без изменений
          }
        }
        controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      if (sseLineBuffer) {
        controller.enqueue(encoder.encode(sseLineBuffer));
      }

      // Защита от пустых ответов:
      // если из-за обрезки мыслей не выведено ни одного символа и нет тулов, отдаем
      // спасенные мысли обратно, чтобы диалог в Zed не завершался с пустой плашкой
      if (emittedContentLength === 0 && !hasToolCalls && strippedThoughtBuffer.trim().length > 0) {
        const fallbackChunk = {
          choices: [
            {
              delta: { content: strippedThoughtBuffer },
              finish_reason: "stop",
            },
          ],
        };
        controller.enqueue(encoder.encode("data: " + JSON.stringify(fallbackChunk) + "\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    },
  });
}
