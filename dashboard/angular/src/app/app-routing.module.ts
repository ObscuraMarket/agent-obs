import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { AgentComponent } from './pages/agent/agent.component';

// The desk is served at both / and /agent so links copied from the main site keep working.
const routes: Routes = [
  { path: '', component: AgentComponent },
  { path: 'agent', component: AgentComponent },
  { path: '**', redirectTo: '' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
