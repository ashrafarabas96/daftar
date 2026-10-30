/**
 * C1.5 — THE NEST BEHAVIOUR THE SCHEMA FLOOR GATE'S WIRING DEPENDS ON.
 *
 * `runtime.ts` provides `Database` through a `useFactory` rather than as a
 * bare class, for one reason: a factory can declare `SCHEMA_VERSION_GUARD` in
 * its `inject` list, which is what makes «the gate runs before any money read»
 * structural rather than a matter of declaration order.
 *
 * That wiring has a cost, and this file is here to keep it honest.
 * `Database.onModuleInit` (`apps/api/src/infra/database.ts:755`) is where the
 * DB PRINCIPAL check lives — the one that refuses to start when a runtime
 * boundary has connected as the wrong role. If Nest called `onModuleInit` only
 * on CLASS providers, then moving `Database` behind a factory would have
 * switched that check off, and nothing would have gone red: the application
 * would boot, serve every route, and simply never verify its own principal
 * again.
 *
 * So the behaviour is MEASURED rather than assumed, in a test that needs no
 * database and no application. If a Nest upgrade ever changes it, this fails
 * and names the consequence instead of leaving a security check quietly
 * inert.
 */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

const fired: string[] = [];

class ClassProvided {
  async onModuleInit(): Promise<void> {
    fired.push('class');
  }
}

class FactoryProvided {
  async onModuleInit(): Promise<void> {
    fired.push('factory');
  }
}

/** A provider that depends on another, which is the shape `Database` now has. */
class DependsOnAGate {
  constructor(readonly gate: number) {}
  async onModuleInit(): Promise<void> {
    fired.push(`gated:${this.gate}`);
  }
}

const GATE = Symbol('GATE');

@Module({
  providers: [
    ClassProvided,
    { provide: FactoryProvided, useFactory: () => new FactoryProvided() },
    { provide: GATE, useFactory: (): Promise<number> => Promise.resolve(86) },
    { provide: DependsOnAGate, useFactory: (gate: number) => new DependsOnAGate(gate), inject: [GATE] },
  ],
})
class ProbeModule {}

describe('C1.5 — Nest lifecycle on factory providers', () => {
  it('onModuleInit fires on a FACTORY-provided instance exactly as on a class provider', async () => {
    fired.length = 0;
    const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await mod.init();
    try {
      // The class half is the CONTROL: if neither fired, the probe measured a
      // broken harness rather than Nest's behaviour.
      expect(fired, 'a class provider’s onModuleInit fires, so the harness works').toContain('class');
      expect(
        fired,
        `a FACTORY-provided instance's onModuleInit did NOT fire. runtime.ts provides Database through a factory so it can depend on the schema ` +
          `floor gate; if Nest no longer calls the hook, Database.onModuleInit — the DB PRINCIPAL check that refuses to start on the wrong role — ` +
          `is now DEAD CODE in every process. Either restore Database to a class provider and find another way to order the gate, or call the ` +
          `check explicitly from the factory.`,
      ).toContain('factory');
    } finally {
      await mod.close();
    }
  });

  it('and an async factory dependency is RESOLVED before the provider that injects it is constructed', async () => {
    fired.length = 0;
    const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await mod.init();
    try {
      // This is the ordering guarantee the gate's placement rests on: the
      // awaited value, not a pending promise, reaches the dependent provider.
      expect(
        fired,
        `an async dependency reached its consumer unresolved. The schema floor gate is an async factory that Database injects, so if Nest did not ` +
          `await it, Database would be built — and money read through it — while the schema check was still in flight.`,
      ).toContain('gated:86');
    } finally {
      await mod.close();
    }
  });
});
