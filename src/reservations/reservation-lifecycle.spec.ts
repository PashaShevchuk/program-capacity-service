import {
  ALLOWED_RESERVATION_TRANSITIONS,
  InvoiceReservationEntity,
  ReservationStatus,
} from './invoice-reservation.entity';

const reservationWith = (status: ReservationStatus): InvoiceReservationEntity => {
  const reservation = new InvoiceReservationEntity();
  reservation.status = status;
  reservation.reservedAmountMinor = 100_000n;
  reservation.programCurrency = 'USD';
  return reservation;
};

describe('reservation lifecycle', () => {
  it('allows an open reservation to be released or cancelled', () => {
    const reservation = reservationWith(ReservationStatus.Reserved);

    expect(reservation.canTransitionTo(ReservationStatus.Released)).toBe(true);
    expect(reservation.canTransitionTo(ReservationStatus.Cancelled)).toBe(true);
    expect(reservation.isOpen).toBe(true);
  });

  it('treats released and cancelled as terminal', () => {
    for (const status of [ReservationStatus.Released, ReservationStatus.Cancelled]) {
      const reservation = reservationWith(status);

      expect(ALLOWED_RESERVATION_TRANSITIONS[status]).toHaveLength(0);
      expect(reservation.canTransitionTo(ReservationStatus.Released)).toBe(false);
      expect(reservation.canTransitionTo(ReservationStatus.Cancelled)).toBe(false);
      expect(reservation.isOpen).toBe(false);
    }
  });

  it('returns the amount that was reserved, in the program currency', () => {
    const reservation = reservationWith(ReservationStatus.Reserved);
    reservation.invoiceAmountMinor = 100_000_000n;
    reservation.invoiceCurrency = 'EUR';
    reservation.reservedAmountMinor = 108_500_000n;

    expect(reservation.reservedAmount.toString()).toBe('1085000.00 USD');
    expect(reservation.invoiceAmount.toString()).toBe('1000000.00 EUR');
  });
});
