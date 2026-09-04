import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { FormsModule } from "@angular/forms";
import { AppComponent } from "./app.component";
import { DropSetupsComponent } from "./drop-setups/drop-setups.component";
import { ProfilePaymentComponent } from "./profile-payment/profile-payment.component";
import { RuntimeControlComponent } from "./runtime-control/runtime-control.component";

@NgModule({
  declarations: [AppComponent, RuntimeControlComponent, DropSetupsComponent, ProfilePaymentComponent],
  imports: [BrowserModule, FormsModule],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule {}
