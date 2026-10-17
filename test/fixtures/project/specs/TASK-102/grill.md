# Grill ledger: TASK-102

## Questions

### Q1: What should happen when phone_number has an invalid format?
- Status: answered
- Answer: Respond 400 with error.code "INVALID_PHONE".

### Q2: Should PUT accept null to clear the phone number?
- Status: assumption
- Answer: Yes, null clears it.
- Approved: yes

## Facts

- Users are updated by updateUser [repo:src/routes/users.ts:9 "export function updateUser("]
- The User model already has a nullable phoneNumber field [repo:src/routes/users.ts:1-5 "phoneNumber: string | null;"]
- A successful update responds 200 [spec:AC-1]
- Invalid phone numbers respond 400 with INVALID_PHONE [human:Q1] [repo:src/routes/users.ts:17 "PHONE_ERROR = \"INVALID_PHONE\""]
- Sending null clears the phone number [human:Q2]
