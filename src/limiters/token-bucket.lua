-- Atomic token bucket: read, refill, decide, write, set TTL.
-- KEYS[1]: bucket key
-- ARGV[1]: refill rate in tokens per second
-- ARGV[2]: burst (bucket capacity)
-- Returns { allowed (1 or 0), retry_after_ms }

local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])

local time = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local bucket = redis.call('HMGET', key, 'tokens', 'updated_at_ms')
local tokens = tonumber(bucket[1]) or burst
local updated_at_ms = tonumber(bucket[2]) or now_ms
tokens = math.min(burst, tokens + math.max(0, now_ms - updated_at_ms) * rate / 1000)

local allowed = 0
local retry_after_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after_ms = math.ceil((1 - tokens) * 1000 / rate)
end

redis.call('HSET', key, 'tokens', tokens, 'updated_at_ms', now_ms)
-- After burst / rate seconds idle the bucket is full, which is what a missing key reads as.
redis.call('PEXPIRE', key, math.ceil(burst * 1000 / rate))

return { allowed, retry_after_ms }
