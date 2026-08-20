#!/usr/bin/env node
/**
 * merkle-allowlist — builds Merkle allowlist roots and proofs for the
 * Soroban `aid_escrow` contract's `claim_with_proof` verifier.
 *
 * The contract (app/onchain/contracts/aid_escrow/src/lib.rs) verifies proofs
 * with:
 *
 *   v1 leaf: sha256(<canonical Address string>)
 *   v2 leaf: sha256(<canonical Address string> || <amount big-endian i128>)
 *   pair:    sha256(sorted(left, right))     // sorted = byte-wise ascending
 *   root:    the Merkle root built with that leaf and pairing rule
 *
 * Proofs are hex-encoded (64 lowercase hex chars, no 0x prefix), bottom-up,
 * one sibling per tree level. The `merkle_root` and `merkle_root_expires_at`
 * metadata values published on a package are read from the allowlist emitted
 * here.
 *
 * This tool deliberately has ZERO dependencies: Node's `crypto` module only.
 * No ethers, no merkletreejs, no keccak256 — the previous EVM-flavored
 * implementation produced proofs no Soroban verifier could accept.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/**
 * v1 Contract-compatible leaf: sha256 of the exact bytes `Address::to_string()`
 * produces on-chain.
 */
function makeLeafV1(addressString) {
  return sha256(Buffer.from(addressString, 'utf8'));
}

/**
 * v2 Contract-compatible leaf: sha256(address_string || amount_be_bytes).
 *
 * The amount is encoded as a big-endian i128 (16 bytes), matching the
 * on-chain `hash_leaf_v2` function in `aid_escrow/src/lib.rs`.
 */
function makeLeafV2(addressString, amount) {
  const amountBuf = Buffer.alloc(16);
  let val = BigInt(amount);
  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(val & 0xFFn);
    val >>= 8n;
  }
  const addrBuf = Buffer.from(addressString, 'utf8');
  return sha256(Buffer.concat([addrBuf, amountBuf]));
}

/**
 * Creates a leaf based on the entry format.
 * If entry has an `amount` field, uses v2 format; otherwise v1.
 */
function makeLeaf(entry) {
  if (typeof entry === 'string') return makeLeafV1(entry);
  if (entry.amount !== undefined) return makeLeafV2(entry.address, entry.amount);
  return makeLeafV1(entry.address);
}

/** Contract-compatible pair combine: sort the two 32-byte hashes byte-wise
 *  ascending, then hash left || right with sha256. */
function hashPair(left, right) {
  const [a, b] = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return sha256(Buffer.concat([a, b]));
}

/** Returns the tree root (Buffer) for the given allowlist leaves. */
function buildRoot(leaves) {
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashPair(level[i], level[i + 1]));
      else next.push(level[i]); // odd leaf promoted unchanged
    }
    level = next;
  }
  return level[0];
}

/** Returns the proof (array of Buffers, bottom-up) for the leaf at `index`. */
function buildProof(leaves, index) {
  let level = leaves.slice();
  let idx = index;
  const proof = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(hashPair(level[i], level[i + 1]));
        if (i === idx) proof.push(level[i + 1]);
        else if (i + 1 === idx) proof.push(level[i]);
      } else {
        next.push(level[i]);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/** Replicates the contract's `verify_merkle_proof_for_claimant` walk. */
function verify(leaf, proof, root) {
  let current = leaf;
  for (const sibling of proof) current = hashPair(current, sibling);
  return current.equals(root);
}

const toHex = (buf) => buf.toString('hex');

function formatResult({ success, code, message, details }) {
  const out = { success: !!success };
  if (success) out.code = 'OK';
  else out.error = { code: code || 'UNKNOWN', message: message || '', details: details || null };
  return out;
}

function main() {
  const samplePath = path.resolve(__dirname, 'sample_allowlist.json');
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

  if (!Array.isArray(sample) || sample.length === 0) {
    throw new Error('sample_allowlist.json must be a non-empty array of { address } entries');
  }

  const hasAmount = sample.length > 0 && sample[0].amount !== undefined;
  const leafVersion = hasAmount ? 'v2' : 'v1';

  const leaves = sample.map((entry) => {
    if (typeof entry.address !== 'string' || !/^[A-Z2-7]{56}$/.test(entry.address)) {
      throw new Error(`Invalid Stellar address in allowlist: ${entry.address}`);
    }
    return makeLeaf(entry);
  });

  const root = buildRoot(leaves);
  const rootHex = toHex(root);
  console.log(`ROOT: ${rootHex}`);
  console.log(`LEAF_VERSION: ${leafVersion}`);

  // 1) Valid proof for the first entry.
  const validIndex = 0;
  const validLeaf = leaves[validIndex];
  const proof = buildProof(leaves, validIndex);
  const valid = verify(validLeaf, proof, root);
  console.log(
    JSON.stringify({
      scenario: 'valid',
      result: formatResult({
        success: valid,
        message: valid ? 'Proof valid' : 'Proof invalid',
      }),
      proof: proof.map(toHex),
      leaf: toHex(validLeaf),
      root: rootHex,
    })
  );

  // 2) Invalid proof path (tamper one proof element).
  const badProofPath = proof.map((b) => Buffer.from(b));
  if (badProofPath.length > 0) {
    const hex = badProofPath[0].toString('hex');
    const tampered = hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
    badProofPath[0] = Buffer.from(tampered, 'hex');
  }
  const invalidPathValid = verify(validLeaf, badProofPath, root);
  console.log(
    JSON.stringify({
      scenario: 'invalid_proof_path',
      result: formatResult({
        success: invalidPathValid,
        code: invalidPathValid ? 'OK' : 'INVALID_PROOF',
        message: invalidPathValid ? 'Unexpectedly valid' : 'Proof path invalid',
      }),
      proof: badProofPath.map(toHex),
      leaf: toHex(validLeaf),
      root: rootHex,
    })
  );

  // 3) Wrong recipient (a leaf for an address not in the tree).
  const stranger = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const wrongLeaf = makeLeaf({ address: stranger, amount: hasAmount ? sample[0].amount : undefined });
  const wrongRecipientValid = verify(wrongLeaf, proof, root);
  console.log(
    JSON.stringify({
      scenario: 'wrong_recipient',
      result: formatResult({
        success: wrongRecipientValid,
        code: wrongRecipientValid ? 'OK' : 'WRONG_RECIPIENT',
        message: wrongRecipientValid ? 'Unexpectedly valid' : 'Proof does not match recipient',
      }),
      proof: proof.map(toHex),
      leaf: toHex(wrongLeaf),
      root: rootHex,
    })
  );

  // 4) Wrong leaf (an in-tree address hashed with a non-canonical encoding,
  //    e.g. the old amount-bound keccak-style layout — proves the leaf
  //    format is enforced, not just the address).
  const inTree = sample[0].address;
  const wrongEncodingLeaf = sha256(Buffer.from(inTree + ':' + '1', 'utf8'));
  const wrongLeafValid = verify(wrongEncodingLeaf, proof, root);
  console.log(
    JSON.stringify({
      scenario: 'wrong_leaf',
      result: formatResult({
        success: wrongLeafValid,
        code: wrongLeafValid ? 'OK' : 'WRONG_LEAF',
        message: wrongLeafValid ? 'Unexpectedly valid' : 'Leaf data mismatch',
      }),
      proof: proof.map(toHex),
      leaf: toHex(wrongEncodingLeaf),
      root: rootHex,
    })
  );

  // 5) Mismatched root (root of a different tree built from the same leaves
  //    in a different order — with sorted-pair hashing this changes the root).
  const altRoot = buildRoot(leaves.slice().reverse());
  const mismatchedValid = verify(validLeaf, proof, altRoot);
  console.log(
    JSON.stringify({
      scenario: 'mismatched_root',
      result: formatResult({
        success: mismatchedValid,
        code: mismatchedValid ? 'OK' : 'MISMATCHED_ROOT',
        message: mismatchedValid ? 'Unexpectedly valid' : 'Root mismatch',
      }),
      proof: proof.map(toHex),
      leaf: toHex(validLeaf),
      altRoot: toHex(altRoot),
    })
  );

  // 6) Full proof dump for every entry (useful for publishing `merkle_root`
  //    metadata and distributing per-recipient proofs).
  const entries = sample.map((entry, i) => ({
    address: entry.address,
    ...(hasAmount ? { amount: entry.amount } : {}),
    proof: buildProof(leaves, i).map(toHex),
  }));
  console.log(JSON.stringify({ scenario: 'proofs', entries }));

  console.log('Merkle allowlist checks complete');
}

try {
  main();
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
}
