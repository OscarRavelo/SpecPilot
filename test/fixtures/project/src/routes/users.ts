export interface User {
  id: number;
  name: string;
  phoneNumber: string | null;
}

const users = new Map<number, User>();

export function updateUser(id: number, changes: Partial<User>): User | undefined {
  const user = users.get(id);
  if (!user) return undefined;
  const updated = { ...user, ...changes };
  users.set(id, updated);
  return updated;
}

export const PHONE_ERROR = "INVALID_PHONE";
