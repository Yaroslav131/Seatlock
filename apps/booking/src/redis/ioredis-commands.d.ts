import 'ioredis';

// HoldsService регистрирует эти команды через redis.defineCommand —
// без этого расширения типов TS не знал бы про redis.createHold/releaseHold.
declare module 'ioredis' {
  interface Redis {
    createHold(
      holdKey: string,
      userHoldKey: string,
      eventHoldsKey: string,
      userId: string,
      seatId: string,
      ttlSeconds: string,
      eventId: string,
      nowMs: string,
    ): Promise<number>;

    releaseHold(
      userHoldKey: string,
      eventHoldsKey: string,
      userId: string,
      eventId: string,
    ): Promise<number>;
  }
}
