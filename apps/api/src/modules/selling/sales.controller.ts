import { Body, Controller, Get, HttpCode, Inject, Param, Post, UsePipes } from '@nestjs/common';
import type { SaleDto } from '@daftar/shared-contracts';
import { Membership, RequiresPermission } from '../../common/guards';
import { ZodValidationPipe } from '../../common/validation';
import { newBusinessTransactionId } from '../inventory/business-transaction';
import { strictUuidParam } from '../inventory/canonical-id';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { SaleCommitService } from './sale-commit.service';
import { SaleReadService } from './sale-reads';
import { SaleCommitSchema, type SaleCommitRequest } from './selling.schemas';

/**
 * The sale routes of P4-S2 — ONE command and ONE read (lock P4-AL-16,
 * P4-AL-30, P4-AL-35, P4-AL-40; docs/PHASE_4_S2_CONTRACT.md A-01, A-12).
 *
 * **There is exactly one writing route, and the surface is the law.**
 * `POST /v1/sales` commits the sale, its items, the stock movements, the
 * bridge rows, the COGS entry, the invoice, its items, its number and the
 * revenue/AR entry in ONE transaction. There is deliberately NO
 * `POST /v1/sales/:id/confirm`, no `POST /v1/sales/:id/invoice`, no
 * `POST /v1/sales/:id/post` and no draft-then-commit pair, because each of
 * those IS one of the seven states P4-AL-16 forbids, offered over HTTP. A
 * route that did half of the command would be the first half of a split
 * commit, and the whole point of the slice is that the halves cannot be
 * separated.
 *
 * **There is no void and no return route either** (`TL-P4-S2-K1`): a
 * registered operation kind is a registration of authority, `0077` registers
 * `sale.commit` ALONE, and `sale.void` / `sale.return` belong to the slices
 * that supply their writers. A route here for either one would claim an
 * authority the database does not grant.
 *
 * **Idempotency is in the body, not in a header** (P4-AL-30). The route takes
 * no `Idempotency-Key`: the caller-supplied `saleId` IS the key and the stored
 * `commit_intent_sha256` is what makes it a proof, because "a bare key proves
 * a request was seen before and says nothing about WHICH request it was". A
 * replay with this id and the same intent is answered from the stored rows; a
 * replay with a different intent is refused `sale.idempotency_conflict`.
 *
 * `HttpCode(200)` rather than 201 on the commit, for the same reason the
 * purchase receipt uses it: a replay returns the SAME body, and answering 201
 * to a call that created nothing would tell the client it had just made a
 * second sale.
 *
 * The branch is never a request field. The server resolves it from the
 * warehouse's immutable home branch, and a member without scope over that
 * branch is stopped by the RLS policy rather than by a predicate this
 * controller writes (P4-AL-40).
 */
@Controller('/v1/sales')
export class SalesController {
  constructor(
    @Inject(SaleCommitService) private readonly commits: SaleCommitService,
    @Inject(SaleReadService) private readonly reads: SaleReadService,
  ) {}

  /**
   * THE ATOMIC SALE COMMIT. Requires `sales.create`; a `credit` sale
   * additionally requires `receivables.view` and any non-zero line discount
   * additionally requires the SENSITIVE `sales.discount` — both checked in the
   * service, because both depend on the BODY and a decorator cannot see it.
   * A discount asked without the key is refused, never silently zeroed.
   */
  @Post()
  @HttpCode(200)
  @RequiresPermission('sales.create')
  @UsePipes(new ZodValidationPipe(SaleCommitSchema))
  async commit(@Membership() m: MembershipContext, @Body() body: SaleCommitRequest): Promise<SaleDto> {
    return this.commits.commit(m, body, newBusinessTransactionId());
  }

  /**
   * One committed sale, read back from the stored rows. Requires `sales.view`.
   * Its COGS figure is the posted entry's and its settlement is not reported
   * at all: both are derived, never stored twice (P4-AL-06, P4-AL-25).
   */
  @Get(':saleId')
  @RequiresPermission('sales.view')
  async read(@Membership() m: MembershipContext, @Param('saleId') saleId: string): Promise<SaleDto> {
    return this.reads.read(m, strictUuidParam(saleId, 'saleId'));
  }
}
