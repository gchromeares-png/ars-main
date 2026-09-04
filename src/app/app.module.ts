import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { FormsModule } from "@angular/forms";
import { AppComponent } from "./app.component";
import { DropSetupsComponent } from "./drop-setups/drop-setups.component";
import { RuntimeControlComponent } from "./runtime-control/runtime-control.component";
import { ApiKeyStatusComponent } from "./api-key-status/api-key-status.component";

@NgModule({
  declarations: [AppComponent, RuntimeControlComponent, DropSetupsComponent, ApiKeyStatusComponent],
  imports: [BrowserModule, FormsModule],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule {}
