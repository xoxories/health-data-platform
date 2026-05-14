/**
 * Cross-component helpers for reading on-chain event logs in bounded
 * chunks, plus a couple of small formatters that the dashboards reuse.
 *
 * Why chunking matters: Alchemy / Infura cap `eth_getLogs` to a 50 000
 * block window. With a deployment block sometimes thousands of blocks
 * behind `latest`, an unbounded `queryFilter(filter, 0, "latest")` fails
 * mid-page. We paginate up to `maxChunks` × `chunkSize` blocks from a
 * configured `fromBlock` floor (DEPLOY_BLOCK in contract.js).
 */

/**
 * Read all matching events between `fromBlock` and `toBlock`, paging in
 * `chunkSize`-block windows, capped at `maxChunks` chunks total.
 *
 * Returns the merged events sorted by `blockNumber, logIndex` ascending.
 * On a per-chunk error, attaches `result.partial = true` and stops; the
 * caller can decide whether to surface the partial result or retry.
 *
 * @param {import("ethers").Contract} contract
 * @param {import("ethers").EventFilter} filter
 * @param {number} fromBlock          Inclusive lower bound (e.g. DEPLOY_BLOCK).
 * @param {number|string} toBlock     Inclusive upper bound (`"latest"` ok).
 * @param {number} [chunkSize=49000]  Stay safely under Alchemy's 50k cap.
 * @param {number} [maxChunks=5]      Hard ceiling on total chunks read.
 * @returns {Promise<{ events: Array, partial: boolean, lastBlockScanned: number }>}
 */
export async function readEventsChunked(
  contract,
  filter,
  fromBlock,
  toBlock,
  chunkSize = 49000,
  maxChunks = 5
) {
  const provider = contract.provider;
  const resolvedTo =
    typeof toBlock === "number" ? toBlock : await provider.getBlockNumber();
  const resolvedFrom = Math.max(0, Number(fromBlock) || 0);

  const events = [];
  let cursor = resolvedFrom;
  let chunksRead = 0;
  let partial = false;
  let lastBlockScanned = resolvedFrom;

  while (cursor <= resolvedTo && chunksRead < maxChunks) {
    const end = Math.min(cursor + chunkSize - 1, resolvedTo);
    try {
      const slice = await contract.queryFilter(filter, cursor, end);
      events.push(...slice);
      lastBlockScanned = end;
    } catch (err) {
      console.error(
        `[events] chunk ${cursor}–${end} failed:`,
        err?.message || err
      );
      partial = true;
      break;
    }
    cursor = end + 1;
    chunksRead += 1;
  }

  // If we ran out of chunks before reaching toBlock, the read is partial.
  if (cursor <= resolvedTo) partial = true;

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  return { events, partial, lastBlockScanned };
}

/**
 * Short-form an Ethereum address as "0xAAAA…BBBB" (4 chars each side).
 * Returns the input untouched if it's not a string.
 */
export function shortAddr(address) {
  if (typeof address !== "string" || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Short-form an arbitrary hex string (bytes32, CID, tx hash) using the
 * same 4-char/4-char shape as {@link shortAddr}.
 */
export function shortHex(hex) {
  if (typeof hex !== "string" || hex.length <= 10) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * Render a unix-seconds timestamp as a human-friendly relative phrase
 * (e.g. "just now", "5 minutes ago", "2 hours ago", "3 days ago").
 * Anything older than 30 days falls through to an absolute `Date`
 * formatted with the user's locale.
 *
 * Pass a BigNumber-like (with `.toNumber()`), number, or numeric string.
 */
export function timestampToRelative(unixSeconds) {
  if (unixSeconds == null) return "";
  const seconds =
    typeof unixSeconds === "number"
      ? unixSeconds
      : typeof unixSeconds === "bigint"
        ? Number(unixSeconds)
        : typeof unixSeconds?.toNumber === "function"
          ? unixSeconds.toNumber()
          : Number(unixSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";

  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - seconds;

  if (diff < 0) {
    // Clock skew or future timestamp — show absolute.
    return new Date(seconds * 1000).toLocaleString();
  }
  if (diff < 45) return "just now";
  if (diff < 60 * 60) {
    const m = Math.max(1, Math.round(diff / 60));
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < 60 * 60 * 24) {
    const h = Math.round(diff / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diff < 60 * 60 * 24 * 30) {
    const d = Math.round(diff / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * Convert a BigNumber-ish (BN / bigint / number / numeric string) to a
 * plain JS number. Returns 0 for null/undefined.
 */
export function toNumberSafe(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value?.toNumber === "function") return value.toNumber();
  return Number(value);
}

/**
 * Best-effort absolute-timestamp resolver for an event. We try the
 * event's own timestamp arg first (most of our contracts emit one),
 * falling back to the event's block's timestamp.
 */
export async function eventTimestamp(event, fallbackProvider) {
  const argTs = event?.args?.timestamp;
  if (argTs != null) {
    const n = toNumberSafe(argTs);
    if (n > 0) return n;
  }
  try {
    const provider = fallbackProvider || event?.getBlock?.bind(event);
    const block = await (typeof provider === "function"
      ? provider()
      : provider?.getBlock?.(event.blockNumber));
    return block?.timestamp ?? 0;
  } catch {
    return 0;
  }
}
