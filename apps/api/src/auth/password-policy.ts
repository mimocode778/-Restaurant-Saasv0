// Rules for a new password. Long passwords beat complicated ones, so the rules are:
// at least 10 characters, not a well-known password, not the email.
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

// Frequent passwords (and their simple variations are caught by the normalisation below).
const COMMON = new Set([
  '1234567890', '0123456789', '12345678910', '1234567891', '0987654321', '1111111111', '0000000000',
  'qwertyuiop', 'azertyuiop', 'password', 'password1', 'password12', 'password123', 'motdepasse',
  'motdepasse1', 'motdepasse123', 'iloveyou', 'iloveyou12', 'qwerty1234', 'azerty1234', 'azerty123',
  'abc123456', 'abcdefghij', 'abcd123456', 'admin12345', 'administrator', 'welcome123', 'bienvenue',
  'bienvenue1', 'soleil123', 'tunisie123', 'tunisia123', 'tunis12345', 'restaurant', 'restaurant1',
  'restaurant123', 'letmein123', 'football123', 'princess123', 'sunshine123', 'dragon1234', 'monkey1234',
  'baseball123', 'superman123', 'trustno1234', 'master1234', 'shadow1234', 'michael123', 'chocolate1',
  'changeme123', 'passw0rd123', 'p@ssw0rd123', 'aaaaaaaaaa', 'zzzzzzzzzz', 'q1w2e3r4t5', 'a1b2c3d4e5',
  '1q2w3e4r5t', 'zaq12wsxcde', 'qazwsxedc123', '123qweasdzxc', 'asdfghjkl1', 'loveyou123', 'samsung123',
  'galaxy1234', 'internet123', 'computer123', 'whatever123', 'freedom123', 'hello12345', 'secret1234',
]);

function normalise(p: string): string {
  return p
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[$5]/g, 's')
    .replace(/[^a-z0-9]/g, '');
}

const COMMON_NORMALISED = new Set([...COMMON].map(normalise));

// Returns a message explaining what is wrong, or null if the password is acceptable.
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `A password can have at most ${MAX_PASSWORD} characters`;
  if (new Set(password).size < 4) return 'This password repeats the same few characters';
  if (COMMON.has(password.toLowerCase()) || COMMON_NORMALISED.has(normalise(password))) {
    return 'This password is too common';
  }
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'The password must not contain the email address';
  }
  return null;
}
