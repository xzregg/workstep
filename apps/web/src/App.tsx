import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ProjectList from './pages/ProjectList'
import TaskList from './pages/TaskList'
import TaskDetail from './pages/TaskDetail'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/tasks" element={<TaskList />} />
        <Route path="/tasks/:taskId" element={<TaskDetail />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
