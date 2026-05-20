export const PAYMENT_FLOW = {
  WALLET_TOPUP: 'wallet_topup',
  SUBSCRIPTION_RENEWAL: 'subscription_renewal',
  AGENT_REGISTRATION_PAID: 'agent_registration_paid',
} as const;

export type PaymentFlow = (typeof PAYMENT_FLOW)[keyof typeof PAYMENT_FLOW];

export const PAYMENT_STATUS = {
  PENDING: 0,
  SUCCESS: 1,
  FAILED: 2,
} as const;

export type PaymentLifecycleStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export type NormalizedPaymentResult = {
  success: boolean;
  status: 'processed' | 'already_processed' | 'failed';
  flow: PaymentFlow;
  orderId: string;
  paymentId?: string;
  message: string;
};
