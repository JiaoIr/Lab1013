import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

function registration() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return { username: `user_${suffix}`, email: `${suffix}@example.com`, password: "StrongPass7!", confirmPassword: "StrongPass7!" };
}
async function submit(body: unknown): Promise<Response> {
  return fetch(`${process.env.COURSE_API_BASE_URL}/api/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("registers an account without exposing passwords", async () => {
  const input = registration();
  const response = await submit(input);
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.username).toBe(input.username);
  expect(body.email).toBe(input.email);
  expect(body.sessionToken).toEqual(expect.any(String));
  expect(body.sessionToken.length).toBeGreaterThan(0);
  expect(body).not.toHaveProperty("password");
  expect(body).not.toHaveProperty("confirmPassword");
});

test("rejects mismatched passwords", async () => {
  const response = await submit({ ...registration(), confirmPassword: "DifferentPass8!" });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toEqual(expect.stringMatching(/.+/));
});

test("rejects duplicate usernames and emails independently", async () => {
  const first = registration();
  expect((await submit(first)).status).toBe(201);
  expect((await submit({ ...registration(), username: first.username })).status).toBe(409);
  expect((await submit({ ...registration(), email: first.email })).status).toBe(409);
});
