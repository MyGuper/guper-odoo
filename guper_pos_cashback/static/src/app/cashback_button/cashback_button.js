/** @odoo-module **/
// Odoo 19: control buttons nao usam registry. Adicionamos o botao ao
// componente ControlButtons via patch e injetamos o markup no template
// point_of_sale.ControlButtons via t-inherit (cashback_button.xml).
import { patch } from "@web/core/utils/patch";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";

patch(ControlButtons.prototype, {
    async onGuperCashback() {
        const order = this.pos.getOrder();
        const partner = order?.getPartner();
        if (!partner) {
            this.notification.add(_t("Selecione o cliente antes do cashback."), {
                type: "warning",
            });
            return;
        }

        // 1) Cotacao: saldo + maximo resgatavel (reward-by-order server-side).
        let quote;
        try {
            quote = await this._guperCall("/guper/redeem/start", {
                order_uuid: order.uuid,
                config_id: this.pos.config.id,
                partner_id: partner.id,
                items: this._guperItems(order),
            });
        } catch (e) {
            this.notification.add(_t("Falha ao consultar cashback Guper."), {
                type: "danger",
            });
            return;
        }

        const redeemable = quote.redeemable_total || 0;
        if (redeemable <= 0) {
            this.notification.add(_t("Sem saldo resgatavel neste pedido."), {
                type: "info",
            });
            return;
        }

        // 2) TODO(guper): popup para o caixa escolher o valor (0..redeemable).
        const amount = redeemable;

        // 3) PIN sempre exigido no resgate.
        const ok = await makeAwaitable(this.dialog, GuperPinPopup, {
            orderUuid: order.uuid,
            call: (path, params) => this._guperCall(path, params),
        });
        if (!ok) {
            this.notification.add(_t("Resgate cancelado (PIN nao validado)."), {
                type: "warning",
            });
            return;
        }

        // 4) Linha de desconto = produto de cashback com preco negativo.
        //    O confirmOrder (commit do resgate) ocorre no fechamento (PaymentScreen).
        const product = this._guperCashbackProduct();
        if (!product) {
            this.notification.add(_t("Produto de cashback nao configurado na loja."), {
                type: "danger",
            });
            return;
        }
        const line = await this.pos.addLineToCurrentOrder(
            { product_id: product },
            {},
            false // configure=false: nao abre popup de configuracao
        );
        line?.setUnitPrice(-(amount / 100)); // amount em centavos -> moeda
        order.guper_redeem_amount = amount;
        this.notification.add(_t("Cashback aplicado."), { type: "success" });
    },

    _guperCashbackProduct() {
        // Recebe o id inteiro (guper_cashback_product_ref) e resolve o produto
        // ja carregado no POS (available_in_pos=True).
        const ref = this.pos.config.guper_cashback_product_ref;
        return ref ? this.pos.models["product.product"].get(ref) : null;
    },

    _guperItems(order) {
        const cashbackId = this._guperCashbackProduct()?.id;
        return order
            .getOrderlines()
            .filter((l) => l.product_id?.id !== cashbackId && l.getQuantity() > 0)
            .map((l) => ({
                id: l.product_id?.default_code || String(l.product_id?.id),
                name: l.product_id?.display_name,
                quantity: Math.round(l.getQuantity()),
                price: Math.round((l.price_unit || 0) * 100),
                productId: String(l.product_id?.id),
            }));
    },

    async _guperCall(path, params) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }),
        });
        const data = await res.json();
        if (data.error) {
            throw new Error(data.error.data?.message || data.error.message);
        }
        return data.result;
    },
});
