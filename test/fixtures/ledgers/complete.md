# Grill ledger: TASK-102

## Questions

### Q1: What should happen when phone_number has an invalid format?
- Status: answered
- Answer: Respond 400 with error.code "INVALID_PHONE".

### Q2: Should PUT accept null to clear the phone number?
- Status: assumption
- Answer: Yes, null clears it.
- Approved: yes

### Q3: Does this change who may call PUT /users/:id?
- Status: answered
- Answer: No, keep the current auth.

### Q4: Do existing clients need to keep working without phone_number?
- Status: answered
- Answer: Yes, the field is optional.

### Q5: What must not be touched?
- Status: answered
- Answer: The user creation flow (POST /users).

## Facts

- (contract) PUT /users/:id updates a user and responds 200 [spec:AC-1]
- (data) The User model already has a nullable phoneNumber field [repo:src/routes/users.ts:1-5 "phoneNumber: string | null;"]
- (validation, errors) Invalid phone numbers respond 400 with INVALID_PHONE [human:Q1] [repo:src/routes/users.ts:17 "PHONE_ERROR = \"INVALID_PHONE\""]
- (edge-cases) Sending null clears the phone number [human:Q2]
- (auth) Auth stays as it is [human:Q3]
- (compatibility) phone_number is optional, so existing clients keep working [human:Q4]
- (out-of-scope) POST /users is not touched [human:Q5]
