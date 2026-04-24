// tests/unit/rateLimit.test.js
import { describe, it, expect, beforeEach } from "vitest";

class RateLimiter {
  constructor() {
    this.attempts = new Map();
    this.maxAttempts = 5;
    this.windowMs = 15 * 60 * 1000; // 15 minutes
  }

  check(ip) {
    const now = Date.now();
    const record = this.attempts.get(ip);
    
    if (!record || record.resetAt < now) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }
    
    if (record.count >= this.maxAttempts) {
      return { 
        allowed: false, 
        resetAt: record.resetAt,
        remainingMs: record.resetAt - now 
      };
    }
    
    record.count++;
    return { allowed: true };
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, data] of this.attempts.entries()) {
      if (data.resetAt < now) {
        this.attempts.delete(ip);
      }
    }
  }
}

describe("Rate Limiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it("allows first 5 attempts", () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check("192.168.1.100");
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks 6th attempt", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("192.168.1.100");
    }
    
    const result = limiter.check("192.168.1.100");
    expect(result.allowed).toBe(false);
    expect(result.remainingMs).toBeGreaterThan(0);
  });

  it("tracks different IPs separately", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("192.168.1.100");
    }
    
    const result = limiter.check("192.168.1.101");
    expect(result.allowed).toBe(true);
  });

  it("resets after window expires", () => {
    limiter.windowMs = 100; // Short window for testing
    
    for (let i = 0; i < 5; i++) {
      limiter.check("192.168.1.100");
    }
    
    // Wait for window to expire
    return new Promise(resolve => {
      setTimeout(() => {
        const result = limiter.check("192.168.1.100");
        expect(result.allowed).toBe(true);
        resolve();
      }, 150);
    });
  });

  it("cleanup removes expired entries", () => {
    limiter.windowMs = 50;
    limiter.check("192.168.1.100");
    
    return new Promise(resolve => {
      setTimeout(() => {
        limiter.cleanup();
        expect(limiter.attempts.size).toBe(0);
        resolve();
      }, 100);
    });
  });
});
