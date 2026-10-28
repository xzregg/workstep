// Leave room for the old image, uploaded archive, unpacked layers and the new
// image during an image switch. This is a sparse disk, not a 64 GiB reservation.
const MACHINE_DISK_GIB = 64

async function ensureMachineDisk(podman, machine, running) {
  const [details] = JSON.parse(await podman(['machine', 'inspect', machine]))
  const size = details?.Resources?.DiskSize
  if (!Number.isFinite(size) || size <= 0) throw new Error('无法读取沙箱虚拟机磁盘容量，请重试')
  if (size >= MACHINE_DISK_GIB) return
  try {
    if (running) await podman(['machine', 'stop', machine])
    await podman(['machine', 'set', `--disk-size=${MACHINE_DISK_GIB}`, machine])
  } catch (cause) {
    throw new Error(`沙箱虚拟机磁盘扩容至 ${MACHINE_DISK_GIB} GiB 失败；原有数据已保留。请检查沙箱所在磁盘空间后重试：${cause.message}`, { cause })
  }
}

// machine inspect reports the raw disk size, not the guest partition or XFS
// size. Older AppleHV machines can still have the original 20 GiB root inside
// a 64 GiB raw disk. Check the filesystem used by both image storage and /var/tmp.
async function ensureMachineFilesystem(podman, machine) {
  const capacity = async () => {
    const output = await podman(['machine', 'ssh', machine, 'df', '-B1', '--output=size', '/var'])
    const size = Number(output.trim().split(/\s+/).at(-1))
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('无法读取沙箱虚拟机文件系统容量，请重试')
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
    if (await capacity() < minimum) throw new Error('扩容后文件系统总容量仍小于预期')
  } catch (cause) {
    throw new Error(`沙箱虚拟机文件系统扩容失败；原有数据已保留。请检查虚拟机分区与文件系统后重试：${cause.message}`, { cause })
  }
}

function storageError(error, platform) {
  if (!/no space left on device|ENOSPC|disk quota exceeded/i.test(error.message)) return error
  const location = platform === 'linux' ? 'Podman 存储或临时目录所在磁盘' : 'Podman 沙箱虚拟机磁盘'
  return new Error(`${location}空间不足，镜像导入或缓存失败。请释放对应存储空间后重试；清理 Docker 镜像不会释放 Podman 存储空间。原始错误：${error.message}`, { cause: error })
}

module.exports = { MACHINE_DISK_GIB, ensureMachineDisk, ensureMachineFilesystem, storageError }
