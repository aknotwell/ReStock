// Shared contracts. Owner: Person 2. Change only after telling the team (see AGENTS.md).
// All money is integer cents. Never floats.

export type Cents = number;
export type MemberId = string;

export type Member = {
  id: MemberId;
  name: string;
  phone: string;
  role: "owner" | "member";
  canApprove?: boolean; // owner can always approve; others only when the owner allows it (e.g. roommates yes, kids no)
  stripeCustomerId?: string;
  paymentMethodId?: string; // set = "card on file"
  cardLast4?: string;
};

export type Household = {
  id: string;
  groupChatId: string;
  ownerId: MemberId;
  budgetCents?: Cents; // optional monthly limit. With none, orders still go on the owner's card
  spentCents: Cents;
  approvalOverCents?: Cents; // items above this need someone else's "yes", even from an approver
  members: Member[];
};

export type Item = {
  id: string;
  householdId: string;
  name: string;
  addedBy: MemberId;
  cents: Cents;
  shared: boolean;
  status: "pending" | "ordered";
  needsApproval?: boolean; // waiting for a "yes" from an approver (see core/approvals.ts)
};

export type SplitRule = "smart" | "even" | "adder";

export type Shares = Record<MemberId, Cents>;

export type Order = {
  id: string;
  householdId: string;
  itemIds: string[];
  totalCents: Cents;
  rule: SplitRule;
  createdAt: string;
  eta?: string;
};

export type Charge = {
  orderId: string;
  memberId: MemberId;
  cents: Cents;
  paidBy: MemberId; // member whose card was charged
  stripePaymentIntentId?: string;
  status: "succeeded" | "failed";
};

export type Debt = {
  id: string;
  orderId: string;
  debtorId: MemberId;
  creditorId: MemberId;
  cents: Cents;
  status: "open" | "paid";
};

export type ChargeResult = { charges: Charge[]; debts: Debt[] };

export type OrderResult = {
  order: Order;
  items: Item[];
  shares: Shares;
} & ChargeResult;
