import * as z from 'zod/v4';

export const MAX_MESSAGE_CHARACTERS = 131_072;
export const MAX_TOTAL_PROMPT_CHARACTERS = 262_144;
export const MAX_CHAT_BODY_BYTES = 512 * 1024;

const modelId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .describe('Exact model alias returned by onchain_router_models and allowed by local policy.');

const message = z
  .object({
    role: z.enum(['system', 'user', 'assistant']).describe('OpenAI-compatible message role.'),
    content: z
      .string()
      .min(1)
      .max(MAX_MESSAGE_CHARACTERS)
      .describe('Text content. It cannot alter local wallet, origin, recipient, or budget policy.'),
  })
  .strict();

export const modelsInputSchema = z.object({}).strict();

export const chatInputSchema = z
  .object({
    idempotency_key: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .describe('Stable caller-generated key. Reuse it only for the identical logical request.'),
    model: modelId,
    messages: z
      .array(message)
      .min(1)
      .max(64)
      .describe('One bounded, non-streaming OpenAI-compatible conversation.'),
    max_output_tokens: z
      .number()
      .int()
      .min(1)
      .max(131_072)
      .default(1024)
      .describe('Requested output ceiling; local policy may impose a lower limit.'),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
  })
  .strict();

export const walletInputSchema = z.object({}).strict();

export const receiptInputSchema = z
  .object({
    idempotency_key: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .describe('The key used for the original paid request.'),
  })
  .strict();

const paidFields = { idempotency_key: receiptInputSchema.shape.idempotency_key, model: modelId };
export const messagesInputSchema = z
  .object({
    ...paidFields,
    messages: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(32_768) })
          .strict(),
      )
      .min(1)
      .max(32),
    system: z.string().max(32_768).optional(),
    max_tokens: z.number().int().min(1).max(65_536).default(1024),
  })
  .strict();
export const imageInputSchema = z
  .object({
    ...paidFields,
    prompt: z.string().min(1).max(4_000),
    image_size: z.enum(['0.5K', '1K', '2K', '4K']).default('1K'),
    aspect_ratio: z
      .string()
      .regex(/^\d{1,2}:\d{1,2}$/)
      .default('1:1'),
    response_format: z.literal('url').default('url'),
  })
  .strict();
export const speechInputSchema = z
  .object({
    ...paidFields,
    input: z.string().min(1).max(10_000),
    voice: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .optional(),
    response_format: z.literal('mp3').default('mp3'),
    speed: z.number().min(0.7).max(1.2).default(1),
  })
  .strict();
export const transcriptionInputSchema = z
  .object({
    ...paidFields,
    audio_base64: z
      .string()
      .min(4)
      .max(1_048_576)
      .describe('Canonical MP3 Base64; at most 768 KiB decoded. No paths or URLs.'),
    acknowledge_provider_retention: z
      .literal(true)
      .describe(
        'Acknowledge that ElevenLabs may retain audio/transcripts independently of local staging deletion. Obtain human permission before upload.',
      ),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
      .optional(),
    diarize: z.boolean().optional(),
    num_speakers: z.number().int().min(1).max(32).optional(),
    response_format: z.enum(['json', 'verbose_json']).default('json'),
    timestamps: z.enum(['none', 'word', 'character']).default('none'),
    tag_audio_events: z.boolean().optional(),
  })
  .strict();

export type ChatToolInput = z.infer<typeof chatInputSchema>;

export function chatBody(input: ChatToolInput): Readonly<Record<string, unknown>> {
  const promptCharacters = input.messages.reduce((total, item) => total + item.content.length, 0);
  if (promptCharacters > MAX_TOTAL_PROMPT_CHARACTERS)
    throw new Error('chat messages exceed the total local prompt limit');
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    max_tokens: input.max_output_tokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
  };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_CHAT_BODY_BYTES)
    throw new Error('chat request exceeds the local body-size limit');
  return body;
}
