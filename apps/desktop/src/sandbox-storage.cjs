// Leave room for the old image, uploaded archive, unpacked layers and the new
// image during an image switch. This is a sparse disk, not a 64 GiB reservation.
const MACHINE_DISK_GIB = 64

async function ensureMachineDisk(podman, machine, running) {
  const [details] = JSON.parse(await podman(['machine', 'inspect', machine]))
  const size = details?.Resources?.DiskSize
  if (!Number.isFinite(size) || size <= 0) throw new Error('Unable to read sandbox VM disk capacity, please retry')
  if (size >= MACHINE_DISK_GIB) return
  try {
    if (running) await podman(['machine', 'stop', machine])
    await podman(['machine', 'set', `--disk-size=${MACHINE_DISK_GIB}`, machine])
  } catch (cause) {
    throw new Error(`Failed to expand sandbox VM disk to ${MACHINE_DISK_GIB} GiB; original data has been retained. Please check the disk space of the sandbox and retry: ${cause.message}`, { cause })
  }
}

// machine inspect reports the raw disk size, not the guest partition or XFS
// size. Older AppleHV machines can still have the original 20 GiB root inside
// a 64 GiB raw disk. Check the filesystem used by both image storage and /var/tmp.
async function ensureMachineFilesystem(podman, machine) {
  const capacity = async () => {
    const output = await podman(['machine', 'ssh', machine, 'df', '-B1', '--output=size', '/var'])
    const size = Number(output.trim().split(/\s+/).at(-1))
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Unable to read the sandbox VM\'s file system capacity. Please try again.')
    return size
  }
  // Allow for boot/EFI partitions and filesystem metadata.
  const minimum = (MACHINE_DISK_GIB - 2) * 2 ** 30
  if (await capacity() >= minimum) return
  try {
    // Only the dedicated Fedora CoreOS VM's root partition is eligible. Do not
    // guess device numbers or operate on host shares, LVM or other filesystems.
    const script = `set -eu
device=$(readlink -f /dev/disk/by-label/root)
test "$(findmnt -n -o FSTYPE --target /var)" = xfs
test "$(findmnt -n -o MAJ:MIN --target /var)" = "$(lsblk -dn -o MAJ:MIN "$device")"
partition=$(cat "/sys/class/block/$(basename "$device")/partition")
parent=$(lsblk -dn -o PKNAME "$device")
test -n "$parent"
if output=$(growpart "/dev/$parent" "$partition" 2>&1); then
  printf "%s\\n" "$output"
else
  case "$output" in
    NOCHANGE:*) ;;
    *) printf "%s\\n" "$output" >&2; exit 1 ;;
  esac
fi
xfs_growfs /var`
    await podman(['machine', 'ssh', machine, 'sudo', 'sh', '-c', `'${script.replaceAll("'", "'\\''")}'`])
    if (await capacity() < minimum) throw new Error('Total file system capacity after expansion is still less than expected')
  } catch (cause) {
    throw new Error(`Failed to expand the sandbox VM's file system; original data has been preserved. Please check the VM's partitions and file system, then retry: ${cause.message}`, { cause })
  }
}

function storageError(error, platform) {
  if (!/no space left on device|ENOSPC|disk quota exceeded/i.test(error.message)) return error
  const location = platform === 'linux' ? 'Podman 存储或临时目录所在磁盘' : 'Podman 沙箱虚拟机磁盘'
  return new Error(`${location} Insufficient space, failed to import image or cache. Please free up the corresponding storage space and retry; cleaning Docker images will not free up Podman storage space. Original error: ${error.message}`, { cause: error })
}

module.exports = { MACHINE_DISK_GIB, ensureMachineDisk, ensureMachineFilesystem, storageError }
