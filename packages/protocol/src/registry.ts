import type { DescMessage, Message, MessageShape } from '@bufbuild/protobuf';
import * as pa from './gen/ProductionAutomation_pb';

/** CortexMessageType.Enum numeric value -> generated message schema, resolved by naming convention (`<Name>MessageSchema`). */
const byType = new Map<number, DescMessage>();
const typeBySchema = new Map<DescMessage, number>();
const nameByType = new Map<number, string>();

for (const [name, value] of Object.entries(pa.CortexMessageType_Enum)) {
  if (typeof value !== 'number') continue;
  nameByType.set(value, name);
  const schema = (pa as Record<string, unknown>)[`${name}MessageSchema`] as DescMessage | undefined;
  if (schema) {
    byType.set(value, schema);
    typeBySchema.set(schema, value);
  }
}

export function schemaFor(messageType: number): DescMessage | undefined {
  return byType.get(messageType);
}

export function typeFor(schema: DescMessage): number {
  const t = typeBySchema.get(schema);
  if (t === undefined) throw new Error(`no CortexMessageType registered for ${schema.typeName}`);
  return t;
}

export function typeName(messageType: number): string {
  return nameByType.get(messageType) ?? `Unknown(${messageType})`;
}

export type AnyMessage = Message & Record<string, unknown>;
export type { MessageShape };
