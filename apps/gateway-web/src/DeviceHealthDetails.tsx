import type { AdminDevice } from './AdminDeviceActionDialog'

export function DeviceHealthDetails({ device }: { device: AdminDevice }) {
  const description = !device.online ? '设备离线，暂时无法检测本地服务。'
    : device.daemon_health === false ? '设备控制连接在线，但本地服务健康检查未通过。'
    : device.daemon_health === true ? '设备控制连接在线，本地服务健康检查正常。'
    : '设备控制连接在线，尚未上报本地服务健康结果。'
  return <section aria-label="设备健康与排查">
    <h4>设备健康与排查</h4>
    <p>{description}</p>
    {device.daemon_health === false && device.online && <p>当前设备仅上报检查结果，未提供具体错误原因。可能是检查超时、服务返回异常或检查请求失败，需要结合设备日志确认。</p>}
    {(!device.online || device.daemon_health !== true) && <ol>
      <li>在该电脑打开 WorkStep，确认应用及本地后台服务正在运行。</li>
      <li>检查该电脑的网关连接状态及本地后台日志，记录报错时间。</li>
      <li>处理异常后，返回设备列表点击“刷新设备”，查看下一次上报结果。</li>
    </ol>}
  </section>
}
