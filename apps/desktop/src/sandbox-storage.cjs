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

function storageError(error, platform) {
  if (!/no space left on device|ENOSPC|disk quota exceeded/i.test(error.message)) return error
  const location = platform === 'linux' ? 'Podman 存储或临时目录所在磁盘' : 'Podman 沙箱虚拟机磁盘'
  return new Error(`${location}空间不足，镜像导入或缓存失败。请释放对应存储空间后重试；清理 Docker 镜像不会释放 Podman 存储空间。原始错误：${error.message}`, { cause: error })
}

module.exports = { MACHINE_DISK_GIB, ensureMachineDisk, storageError }
