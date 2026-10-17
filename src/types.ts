// Shared contracts. Owner: Person 2. Change only after telling the team (see AGENTS.md).
// All money is integer cents. Never floats.

export type Cents = number;
export type MemberId = string;

export type Member = {
  id: MemberId;
  name: string;
  phone: string;
  role: "owner" | "member";
  stripeCustomerId?: string;
  paymentMethodId?: string; // set = "card on file"
  cardLast4?: string;
};

export type Household = {
  id: string;
  groupChatId: string;
  ownerId: MemberId;
  budgetCents: Cents;
  spentCents: Cents;
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
  needsApproval?: boolean; // expensive personal item awaiting owner "yes"
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
