import { MalformedMessageError } from '../common/errors/domain.errors';
import { TreasuryEventDto } from './dto/treasury-messages.dto';
import { parseMessageBody } from './message-validation';

/**
 * The sequence is the watermark that decides which treasury messages are
 * applied, so accepting a different number than the producer sent would move
 * the watermark to a value nobody chose.
 */
describe('treasury sequence validation', () => {
  const parse = (sequence: unknown) =>
    parseMessageBody('treasury.capacity.events.v1', TreasuryEventDto, {
      eventId: '11111111-1111-4111-8111-111111111111',
      eventType: 'CapacityReleased',
      programCode: 'PRG-1',
      sequence,
      occurredAt: '2026-09-15T10:00:00.000Z',
      payload: { invoiceId: 'INV-1' },
    });

  /** How a message really arrives: a raw Kafka payload through JSON.parse. */
  const fromJson = (sequenceLiteral: string) =>
    parse(
      (
        JSON.parse(`{"sequence":${sequenceLiteral}}`) as {
          sequence: unknown;
        }
      ).sequence,
    );

  it('accepts a plain integer', () => {
    expect(parse(1001).sequence).toBe(1001);
  });

  it('accepts a bigint sent as a string', () => {
    expect(parse('9223372036854775806').sequence).toBe('9223372036854775806');
  });

  it('refuses a JSON number JSON.parse has already rounded', () => {
    // 9007199254741001 does not survive JSON.parse; it becomes ...741000.
    // Accepting it would record a sequence the producer never sent.
    expect(() => fromJson('9007199254741001')).toThrow(MalformedMessageError);
  });

  it('refuses a string beyond what a bigint column holds', () => {
    expect(() => parse('9223372036854775808')).toThrow(MalformedMessageError);
  });

  it('refuses negative, fractional and non-numeric values', () => {
    expect(() => parse(-1)).toThrow(MalformedMessageError);
    expect(() => parse(1.5)).toThrow(MalformedMessageError);
    expect(() => parse('not-a-number')).toThrow(MalformedMessageError);
    expect(() => parse(null)).toThrow(MalformedMessageError);
  });

  it('keeps the exact value for the watermark', () => {
    // BigInt reads either shape, which is what the handlers use.
    expect(BigInt(parse('9223372036854775806').sequence)).toBe(9223372036854775806n);
    expect(BigInt(parse(1001).sequence)).toBe(1001n);
  });
});
