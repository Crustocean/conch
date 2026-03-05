/**
 * Anthropic Claude API client with streaming and tool use support.
 *
 * Handles the iterative tool use loop: send messages with tools, receive
 * tool_use blocks, execute tools, append results, and loop until Claude
 * produces a final text response.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

/**
 * Stream a Claude response. Yields events as they arrive:
 * - { type: 'text', delta: string } — partial text token
 * - { type: 'tool_use', id: string, name: string, input: object } — tool invocation
 * - { type: 'stop', stopReason: string } — generation complete
 *
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model='claude-sonnet-4-20250514']
 * @param {string} opts.system - System prompt
 * @param {Array} opts.messages - Conversation messages
 * @param {Array} [opts.tools] - Tool definitions
 * @param {number} [opts.maxTokens=32768]
 * @param {AbortSignal} [opts.signal] - For interrupt support
 * @returns {AsyncGenerator}
 */
export async function* streamClaude({ apiKey, model = 'claude-sonnet-4-20250514', system, messages, tools, maxTokens = 32768, signal }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    stream: true,
  };
  if (tools?.length) body.tools = tools;

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${err.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolUse = null;
  let toolInputJson = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      let event;
      try { event = JSON.parse(data); } catch { continue; }

      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          currentToolUse = { id: block.id, name: block.name };
          toolInputJson = '';
        }
      }

      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text };
        }
        if (delta?.type === 'input_json_delta' && delta.partial_json) {
          toolInputJson += delta.partial_json;
        }
      }

      if (event.type === 'content_block_stop' && currentToolUse) {
        let input = {};
        try { input = JSON.parse(toolInputJson); } catch {}
        yield { type: 'tool_use', id: currentToolUse.id, name: currentToolUse.name, input };
        currentToolUse = null;
        toolInputJson = '';
      }

      if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) {
          yield { type: 'stop', stopReason: event.delta.stop_reason };
        }
      }
    }
  }
}

/**
 * Run the full tool use loop: call Claude, execute tools, loop until final text.
 *
 * Text from intermediate turns (turns that end with tool calls) is buffered and
 * delivered via onInterstitialText. Only the final turn's text is streamed live
 * via onText, so the user sees a clean final response after the tool work.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {string} opts.system
 * @param {Array} opts.messages - Initial messages
 * @param {Array} opts.tools - Tool definitions
 * @param {Function} opts.onText - Called with each text delta on the FINAL turn only
 * @param {Function} [opts.onInterstitialText] - Called with full text from non-final turns
 * @param {Function} opts.onToolUse - Called with { id, name, input }, must return string result
 * @param {Function} [opts.onFirstToolUse] - Called once before the first tool execution
 * @param {Function} [opts.onTurnComplete] - Called after each tool-use turn
 * @param {Function} [opts.onStatus] - Called with status text
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxTurns=50] - Max tool use loops
 * @param {number} [opts.turnDelayMs=500] - Minimum ms between tool-use turns (rate limiting)
 * @returns {Promise<string>} Final turn's text only
 */
export async function runToolLoop({ apiKey, model, system, messages, tools, onText, onInterstitialText, onToolUse, onFirstToolUse, onTurnComplete, onStatus, signal, maxTurns = 50, turnDelayMs = 500 }) {
  let _firstToolFired = false;
  const conversation = [...messages];
  let interstitialText = '';
  let lastTurnEnd = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const elapsed = Date.now() - lastTurnEnd;
    if (lastTurnEnd > 0 && elapsed < turnDelayMs) {
      await new Promise((r) => setTimeout(r, turnDelayMs - elapsed));
    }
    const textParts = [];
    const toolCalls = [];
    let isStreaming = false;
    let stopReason = null;

    for await (const event of streamClaude({ apiKey, model, system, messages: conversation, tools, signal })) {
      if (event.type === 'text') {
        textParts.push(event.delta);
        if (isStreaming) onText(event.delta);
      }
      if (event.type === 'tool_use') {
        toolCalls.push(event);
      }
      if (event.type === 'stop') {
        stopReason = event.stopReason;
        if (event.stopReason === 'end_turn' && toolCalls.length === 0) {
          if (!isStreaming && textParts.length > 0) {
            isStreaming = true;
            const buffered = textParts.join('');
            onText(buffered);
          }
        }
      }
    }

    const turnText = textParts.join('');

    if (stopReason === 'max_tokens') {
      const truncMsg = turnText
        ? turnText + '\n\n[Response truncated — hit output token limit mid-response]'
        : '[Response truncated — hit output token limit]';
      if (!isStreaming) onText(truncMsg);
      else onText('\n\n[Response truncated — hit output token limit mid-response]');
      return truncMsg;
    }

    if (toolCalls.length === 0) {
      if (!isStreaming && turnText) {
        onText(turnText);
      }
      return turnText;
    }

    if (turnText) {
      interstitialText += (interstitialText ? '\n\n' : '') + turnText;
      if (onInterstitialText) onInterstitialText(turnText);
    }

    if (!_firstToolFired && onFirstToolUse) {
      _firstToolFired = true;
      await onFirstToolUse();
    }

    const assistantContent = [];
    if (turnText) assistantContent.push({ type: 'text', text: turnText });
    for (const tc of toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    conversation.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const tc of toolCalls) {
      if (onStatus) onStatus(`running ${tc.name}...`);
      const result = await onToolUse(tc);
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: String(result ?? '') });
    }
    conversation.push({ role: 'user', content: toolResults });

    lastTurnEnd = Date.now();

    if (onTurnComplete) {
      onTurnComplete(toolCalls.map(tc => ({ name: tc.name, input: tc.input })));
    }
  }

  const limitMsg = `[Stopped — reached the maximum of ${maxTurns} tool-use turns. Work completed so far has been applied.]`;
  onText(limitMsg);
  return limitMsg;
}
