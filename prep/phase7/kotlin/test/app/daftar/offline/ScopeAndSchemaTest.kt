package app.daftar.offline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The Tech Lead's directive PART 40 — local data security — in the part of it
 * the kernel can actually hold: the queue row's owner, and the row layout's
 * version.
 *
 * The rest of PART 40 (platform secure storage, logout revocation, reinstall
 * behaviour, retention) lives on the Android surface and is recorded in
 * `P7-S2-LOCAL-DATA-SECURITY.md` under its own evidence class. Nothing here
 * claims those.
 */
class ScopeAndSchemaTest {
    private val key = "3c2b1a09-8f7e-4d6c-9b5a-4938271605f4"
    private val digest = "sha256:5e4d3c2b"
    private val alice = OwnerScope("tenant-1", "business-1", "member-alice")

    /** The same person, same tenant, after switching to their other business. */
    private val aliceElsewhere = OwnerScope("tenant-1", "business-2", "member-alice")

    /** The next shift on the same till, same business. */
    private val bob = OwnerScope("tenant-1", "business-1", "member-bob")

    private fun sale(scope: OwnerScope = alice) =
        Operation.capture(key, scope, EffectClass.FINANCIAL, digest)

    private fun released(scope: OwnerScope = alice): Operation {
        val step = sale(scope).step(QueueEvent.Release(scope))
        assertIs<Step.Moved>(step)
        return step.operation
    }

    // ── L12: the row carries its owner ───────────────────────────────────

    @Test
    fun `a captured operation records the tenant, business and member it was captured under`() {
        val op = sale()
        assertEquals("tenant-1", op.scope.tenantId)
        assertEquals("business-1", op.scope.businessId)
        assertEquals("member-alice", op.scope.memberId)
    }

    @Test
    fun `a scope with a blank tenant, business or member cannot be constructed`() {
        // Three fields, three ways to be absent, and each is checked
        // separately: a single `require` over all three would pass as long as
        // ONE of them was filled in, which is the shape this test exists to
        // forbid rather than to describe.
        val blanks = listOf("", " ", "\t", "\n")
        var refused = 0
        for (blank in blanks) {
            for (position in 0..2) {
                val t = if (position == 0) blank else "tenant-1"
                val b = if (position == 1) blank else "business-1"
                val m = if (position == 2) blank else "member-1"
                assertFailsWith<IllegalArgumentException>("OwnerScope($t, $b, $m) was accepted") {
                    OwnerScope(t, b, m)
                }
                refused++
            }
        }
        assertEquals(blanks.size * 3, refused, "the sweep did not try every position")
    }

    /**
     * The row's owner is as immutable as its key. There is no `copy` and no
     * mutator, so this is a structural fact; the test records it so that
     * adding one turns something red.
     */
    @Test
    fun `no transition can change the row's owner`() {
        var op = released()
        val seen = mutableListOf(op.scope)
        op = (op.step(QueueEvent.Send(digest, alice)) as Step.Moved).operation
        seen += op.scope
        op = (op.step(QueueEvent.ProcessDeath) as Step.Moved).operation
        seen += op.scope
        op = (op.step(QueueEvent.Send(digest, alice)) as Step.Moved).operation
        seen += op.scope
        op = (
            op.step(QueueEvent.Observe(AttemptResult.Answered(200, null, true, null))) as Step.Moved
            ).operation
        seen += op.scope
        assertEquals(List(5) { alice }, seen, "the owner changed along a legal path")
    }

    // ── L13: no account switch may touch another account's entries ───────

    /**
     * The scenario PART 40 item 2 names. Alice captures a sale in business 1,
     * loses signal, switches to business 2, and the sender runs.
     *
     * What makes this the dangerous case rather than a tidy one: the server
     * derives source identity from `(business, Idempotency-Key)`, and the
     * business comes from the request header while the key comes from the row.
     * Sent under business 2, both halves are internally consistent, so the
     * server commits business 1's sale into business 2's ledger and answers
     * `201`. Nothing downstream can notice. The refusal has to happen here.
     */
    @Test
    fun `a sale captured in one business is not sent under another`() {
        val op = released(alice)
        val step = op.step(QueueEvent.Send(digest, aliceElsewhere))
        assertIs<Step.Refused>(step, "a cross-business send was allowed")
        assertEquals("offline.scope_switched", step.code)
        assertEquals(P7Laws.NO_CROSS_ACCOUNT_SEND.id, step.law)
    }

    @Test
    fun `a refused cross-account send consumes no attempt and leaves the row untouched`() {
        val op = released(alice)
        assertIs<Step.Refused>(op.step(QueueEvent.Send(digest, aliceElsewhere)))
        // The refusal returns no operation at all, which is the strongest form
        // of "nothing moved": there is no object for a caller to mistake for
        // the new state. The original is unchanged and still sendable.
        assertEquals(0, op.attempts)
        assertEquals(OperationState.QUEUED, op.state)
        assertIs<Step.Moved>(op.step(QueueEvent.Send(digest, alice)))
    }

    /**
     * The quieter half of the same law: two staff logins on one till. Bob must
     * not be able to cancel, release or resolve Alice's captures — not because
     * Bob is hostile, but because a till is a shared device and the row is the
     * only record of who took the money.
     */
    @Test
    fun `another member on the same till cannot release, cancel or resolve another member's capture`() {
        val captured = sale(alice)
        // Challenger finding F-05 changed this list: `Send` is no longer
        // here, and the test below it is the reason. What a PERSON decides
        // about someone else's capture is still refused, which is what this
        // half of L13 was always about.
        val attempted: List<QueueEvent> = listOf(
            QueueEvent.Release(bob),
            QueueEvent.CancelByMerchant(bob),
            QueueEvent.ResolveByMerchant(true, bob),
            QueueEvent.ResolveByMerchant(false, bob),
            QueueEvent.RestorePayload(digest, bob),
        )
        for (event in attempted) {
            val step = captured.step(event)
            assertIs<Step.Refused>(step, "$event by another member was allowed")
            assertEquals("offline.scope_switched", step.code, "$event was refused for the wrong reason")
            assertEquals(P7Laws.NO_CROSS_ACCOUNT_SEND.id, step.law)
        }
        assertEquals(5, attempted.size, "every member-gated event must be covered")
    }

    /**
     * The completeness check behind the test above: every event that carries
     * an acting scope is covered by it. A sixth `ByScope` event added later
     * reddens here rather than being silently unguarded — which is the failure
     * the one-gate-ahead-of-every-arm design in `step` exists to prevent, and
     * this is what proves the design is still in place.
     */
    @Test
    fun `every session-originated event is subject to the scope gate`() {
        val byScope: List<QueueEvent.ByScope> = listOf(
            QueueEvent.Release(bob),
            QueueEvent.CancelByMerchant(bob),
            QueueEvent.Send(digest, bob),
            QueueEvent.ResolveByMerchant(true, bob),
            QueueEvent.ResolveByMerchant(false, bob),
            QueueEvent.RestorePayload(digest, bob),
        )
        // `label` below is a `when` over the sealed hierarchy with no `else`,
        // so a seventh `ByScope` event does not fail this assertion — it fails
        // to COMPILE, which is the stronger guard and needs no reflection on
        // the test classpath. The assertion's job is the other direction: that
        // the list actually exercises every arm `label` can reach.
        assertEquals(
            setOf("Release", "CancelByMerchant", "Send", "ResolveByMerchant", "RestorePayload"),
            byScope.map { label(it) }.toSet(),
            "a session-originated event exists that no scope test covers",
        )

        // And the events that are NOT session-originated are deliberately not
        // gated: a server answer and a process death have no session to
        // authorize, and refusing a crash would create a path on which the
        // operating system can be told no.
        assertTrue(QueueEvent.Observe(AttemptResult.NoAnswer) !is QueueEvent.ByScope)
        assertTrue(QueueEvent.ProcessDeath !is QueueEvent.ByScope)
    }

    /**
     * Challenger finding F-05, as the test that would have caught it.
     *
     * The shift change the test above describes, carried one step further.
     * Alice captures a sale while the till is offline; her shift ends and her
     * session is revoked, as PART 40 item 2.3 requires; Bob signs in. If the
     * send is gated on the member too, that row is now unsendable,
     * uncancellable, unresolvable and unminimizable — and L4 and L5 forbid
     * dropping it. A permanently closed state is not fail-closed; it is a
     * material operation that can never settle, which is the same class of
     * defect V2 found in L16.
     *
     * So the send goes through, into the SAME business, under the same key and
     * the same bytes. The member is not a security boundary for a transmission
     * — the server authorizes the sending session itself — and the row still
     * names its capturer for the audit.
     */
    @Test
    fun `the next shift can finish a sale the previous shift captured, and nothing else`() {
        var op = released(alice)

        val sent = assertIs<Step.Moved>(
            op.step(QueueEvent.Send(digest, bob)),
            "Alice's offline sale was stranded when her shift ended, with no way to ever settle it",
        )
        val attempt = sent.effects.filterIsInstance<SideEffect.SendAttempt>().single()
        // F-02: and it goes out under ALICE's scope, not Bob's, because the
        // effect carries the row's own scope rather than the sender's.
        assertEquals(alice, attempt.scope, "the attempt would have been sent under the wrong business")
        assertEquals(op.id, attempt.idempotencyKey)

        // Everything a person decides is still Alice's alone.
        for (event in listOf(QueueEvent.CancelByMerchant(bob), QueueEvent.Release(bob))) {
            val refused = assertIs<Step.Refused>(op.step(event), "$event by the next shift was allowed")
            assertEquals("offline.scope_switched", refused.code)
        }
    }

    /**
     * And the half that is never relaxed, for any event, including the send:
     * the business is the part of the source identity the server cannot
     * validate, so a wrong one is an undetectable cross-tenant write.
     */
    @Test
    fun `the business is compared for every event, the send included`() {
        val otherBusiness = OwnerScope(alice.tenantId, "business-2", alice.memberId)
        val otherTenant = OwnerScope("tenant-2", alice.businessId, alice.memberId)
        val op = released(alice)
        for (foreign in listOf(otherBusiness, otherTenant)) {
            for (event in listOf<QueueEvent>(
                QueueEvent.Send(digest, foreign),
                QueueEvent.CancelByMerchant(foreign),
                QueueEvent.Release(foreign),
                QueueEvent.ResolveByMerchant(true, foreign),
                QueueEvent.RestorePayload(digest, foreign),
            )) {
                val refused = assertIs<Step.Refused>(
                    op.step(event), "$event from $foreign was allowed",
                )
                assertEquals("offline.scope_switched", refused.code)
                assertEquals(P7Laws.NO_CROSS_ACCOUNT_SEND.id, refused.law)
            }
        }
    }

    /**
     * Exhaustive by construction: no `else`. Adding a `ByScope` event without
     * deciding how the scope tests cover it is a compile error, not a silently
     * unguarded path.
     */
    private fun label(event: QueueEvent.ByScope): String = when (event) {
        is QueueEvent.Release -> "Release"
        is QueueEvent.CancelByMerchant -> "CancelByMerchant"
        is QueueEvent.Send -> "Send"
        is QueueEvent.ResolveByMerchant -> "ResolveByMerchant"
        is QueueEvent.RestorePayload -> "RestorePayload"
    }

    @Test
    fun `an answer to an attempt this row made is never refused for scope`() {
        var op = released(alice)
        op = (op.step(QueueEvent.Send(digest, alice)) as Step.Moved).operation
        // The reply arrives after the merchant switched business. The attempt
        // was already made under the right scope; discarding its answer would
        // strand a sale the server may hold.
        val step = op.step(QueueEvent.Observe(AttemptResult.Answered(201, null, false, null)))
        assertIs<Step.Moved>(step, "a server answer was refused because the session changed")
        assertEquals(OperationState.SYNCED, step.operation.state)
    }

    // ── L14: an unreadable row is refused ────────────────────────────────

    @Test
    fun `a captured row records the schema version it was written under`() {
        assertEquals(QueueSchema.CURRENT, sale().schemaVersion)
    }

    @Test
    fun `a row from a schema version this build does not know is refused, not reinterpreted`() {
        // Both directions. The downgrade case — an older build reading a newer
        // row — is the one that matters and the one easy to forget: a row is
        // not self-describing, so reading it under the old field meanings is
        // how a frozen payload stops being the payload that was frozen.
        for (unknown in listOf(QueueSchema.CURRENT + 1, QueueSchema.CURRENT + 7, 0, -1)) {
            val thrown = assertFailsWith<UnreadableQueueRow>("schema $unknown was admitted") {
                QueueSchema.admit(unknown)
            }
            assertEquals(unknown, thrown.version)
            assertEquals(QueueSchema.CURRENT, thrown.current)
            assertTrue(
                thrown.message!!.contains(P7Laws.UNKNOWN_QUEUE_SCHEMA_REFUSED.id),
                "the refusal does not cite its law: ${thrown.message}",
            )
        }
    }

    @Test
    fun `the current schema version is readable and admission is not vacuous`() {
        QueueSchema.admit(QueueSchema.CURRENT)
        assertTrue(QueueSchema.isReadable(QueueSchema.CURRENT))
        assertTrue(
            QueueSchema.READABLE.isNotEmpty() && QueueSchema.CURRENT in QueueSchema.READABLE,
            "the readable set does not contain the version this build writes",
        )
        // A guard that admitted everything would pass every test above except
        // this one's counterpart; a guard that admitted nothing would pass
        // those and fail this. Both halves are asserted.
        assertTrue(QueueSchema.READABLE.size < 100, "READABLE looks like it admits anything")
    }
}
