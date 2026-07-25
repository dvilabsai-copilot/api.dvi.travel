// FILE: src/common/utils/password.util.ts
export function genPwd(length = 7): string {
 const possible = '0123456789bcdfghjkmnpqrstvwxyz'; // no vowels
  let password = '';

  while (password.length < length) {
    const idx = Math.floor(Math.random() * possible.length);
    const char = possible.charAt(idx);
    if (!password.includes(char)) {
      password += char;
    }
  }

  return password;
}
