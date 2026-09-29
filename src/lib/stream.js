export function createGeminiStreamPipeline() {
  let hasToolCalls = false;
  let inThought = false;
  let initialThoughtFinished = false;
  let contentBuffer = "";
  let sseLineBuffer = "";

  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();

  function filterThoughts(content) {
    if (initialThoughtFinished) return content;

    let str = contentBuffer + content;
    contentBuffer = "";

    if (inThought) {
      const closeMatch = str.match(/<\/(thought|thinking)>/i);
      if (closeMatch) {
        inThought = false;
        initialThoughtFinished = true;
        return str.slice(closeMatch.index + closeMatch[0].length);
      }
      if (str.endsWith("<") || str.endsWith("</") || str.endsWith("</t") || str.endsWith("</th")) {
        contentBuffer = str.slice(str.lastIndexOf("<"));
      }
      return "";
    }

    const openMatch = str.match(/<(thought|thinking)>/i);
    if (openMatch) {
      inThought = true;
      const preText = str.slice(0, openMatch.index);
      const rest = str.slice(openMatch.index + openMatch[0].length);

      const immediateClose = rest.match(/<\/(thought|thinking)>/i);
      if (immediateClose) {
        inThought = false;
        initialThoughtFinished = true;
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
          // Если мысли уже отфильтрованы и нет тулов — отдаем строку как есть
          if (initialThoughtFinished && !line.includes('"tool_calls"') && !line.includes('"finish_reason"')) {
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }

          try {
            const json = JSON.parse(line.slice(6));
            const choice = json.choices?.[0];

            if (choice) {
              if (choice.delta?.tool_calls) {
                hasToolCalls = true;
              }

              // Корректируем finish_reason для инструментов
              if (hasToolCalls && choice.finish_reason && choice.finish_reason.toLowerCase() === "stop") {
                choice.finish_reason = "tool_calls";
              }

              // Фильтруем теги рассуждений
              if (choice.delta && typeof choice.delta.content === "string") {
                choice.delta.content = filterThoughts(choice.delta.content);
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
    },
  });
}
