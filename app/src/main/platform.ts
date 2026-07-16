import path from 'node:path';

export const isWin = process.platform === 'win32';

const OPENSSH_DIR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH');

// no Windows os binários vivem em System32; no macOS/Linux estão no PATH
export const SSH_EXE = isWin ? path.join(OPENSSH_DIR, 'ssh.exe') : 'ssh';
export const SSH_KEYGEN_EXE = isWin ? path.join(OPENSSH_DIR, 'ssh-keygen.exe') : 'ssh-keygen';
export const TAR_EXE = isWin
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';
