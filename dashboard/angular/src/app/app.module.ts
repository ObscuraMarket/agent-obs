import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { AgentComponent } from './pages/agent/agent.component';

@NgModule({
  declarations: [AppComponent, AgentComponent],
  imports: [BrowserModule, HttpClientModule, AppRoutingModule],
  bootstrap: [AppComponent]
})
export class AppModule {}
