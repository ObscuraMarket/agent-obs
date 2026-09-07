import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { AgentComponent } from './pages/agent/agent.component';
import { ConsoleComponent } from './pages/console/console.component';

// The desk is served at both / and /agent so links copied from the main site keep working.
const routes: Routes = [
  { path: '', component: AgentComponent },
  { path: 'agent', component: AgentComponent },
  { path: 'console', component: ConsoleComponent },
  { path: '**', redirectTo: '' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
