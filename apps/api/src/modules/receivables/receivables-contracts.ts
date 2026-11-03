/**
 * The result shapes of the P4-S4 receivables surface, re-exported.
 *
 * The five DTOs are declared ONCE, in
 * `packages/shared-contracts/src/customer-settlement.ts`, which is the
 * contract the web client and the API share. This module keeps the import
 * path the services, the reads and the controller already use, so the single
 * declaration site costs no churn in the module that consumes it. Field sets
 * were compared name by name before the swap: all five are identical to the
 * declarations this file previously carried.
 */
export type {
  CustomerPaymentAllocationDto,
  CustomerCreditDto,
  CustomerPaymentDto,
  CustomerPaymentResultDto,
  CustomerCreditApplicationResultDto,
} from '@daftar/shared-contracts';
