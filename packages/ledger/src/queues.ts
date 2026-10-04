/** pg-boss queue names, shared by the worker (consumes) and the API (enqueues). */
export const JOBS = {
  scan: "settlement.scan",
  capture: "settlement.capture",
  retryCapture: "settlement.retry",
  prepaid: "settlement.prepaid",
  topUp: "topup",
  payoutRun: "payouts.run",
  payoutPoll: "payouts.poll",
  deliverEvents: "events.deliver",
  paypalWebhook: "paypal.webhook",
  reconcile: "reconcile",
  pushSend: "push.send",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface EnqueueOptions {
  singletonKey?: string;
  /** Seconds from now, or a date. */
  startAfter?: number | Date;
}

export type Enqueue = (name: JobName, data: object, options?: EnqueueOptions) => Promise<void>;
