"""Run the document suite in a disposable Alpine rootfs using Linux bwrap (no Docker daemon)."""
import hashlib
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

workspace = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix='agentbl-alpine-'))
base = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-minirootfs-3.22.0-x86_64.tar.gz'
try:
    data = urllib.request.urlopen(base, timeout=30).read()
    expected = urllib.request.urlopen(base + '.sha256', timeout=30).read().decode().split()[0]
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError('Alpine rootfs checksum mismatch')
    archive = root / 'rootfs.tar.gz'
    archive.write_bytes(data)
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        # Install all regular files before any absolute OS symlinks are created.
        bundle.extractall(root, members=[member for member in members if member.isdir() or member.isfile()], filter='data')
        for member in members:
            relative = pathlib.PurePosixPath(member.name)
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Unsafe rootfs path')
            if member.islnk():
                source = pathlib.PurePosixPath(member.linkname.lstrip('/'))
                if '..' in source.parts:
                    raise RuntimeError('Unsafe rootfs link')
                shutil.copyfile(root.joinpath(*source.parts), root.joinpath(*relative.parts))
        for member in members:
            if member.issym():
                root.joinpath(*pathlib.PurePosixPath(member.name).parts).symlink_to(member.linkname)
    archive.unlink()
    (root / 'work').mkdir()
    common = ['bwrap', '--die-with-parent', '--unshare-user', '--uid', '0', '--gid', '0',
              '--bind', str(root), '/', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
              '--ro-bind', str(workspace), '/work', '--proc', '/proc', '--dev', '/dev', '--clearenv',
              '--setenv', 'PATH', '/usr/sbin:/usr/bin:/sbin:/bin', '--chdir', '/work']
    print('Alpine minirootfs archive SHA-256:', expected, flush=True)
    subprocess.run(common + ['/sbin/apk', 'add', '--no-cache', 'nodejs'], check=True, timeout=90)
    subprocess.run(common + ['/bin/sh', '-c', 'node --version && cat /etc/alpine-release && node --test tests/documentExtraction.test.js'], check=True, timeout=90)
finally:
    shutil.rmtree(root)
