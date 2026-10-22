/**
 * Minimal client for any OpenAI-compatible chat/completions API:
 * Gemini (OpenAI endpoint), DeepSeek, Qwen/DashScope, Groq, OpenRouter, OpenAI, Ollama…
 * Configured only through env vars, so the provider can be switched in Render without code changes.
 */

export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export function llmConfig(): LlmConfig | undefined {
    const baseUrl = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;
    if (!baseUrl || !model) return undefined;
    return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: process.env.LLM_API_KEY ?? '', model };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export async function chat(messages: ChatMessage[], opts: { json?: boolean; temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const cfg = llmConfig();
    if (!cfg) throw new Error('AI is not configured: set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.');
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature: opts.temperature ?? 0.3,
            max_tokens: opts.maxTokens ?? 4000,
            ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_SECS ?? 120) * 1000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    const content = JSON.parse(text)?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM returned an empty answer');
    return content.trim();
}

/** Parses JSON from a model answer, tolerating ```json fences and surrounding prose. */
export function parseModelJson(answer: string): unknown {
    const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
    const candidate = fenced ?? answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1);
    return JSON.parse(candidate);
}
