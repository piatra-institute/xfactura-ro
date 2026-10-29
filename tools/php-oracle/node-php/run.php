<?php

require __DIR__ . '/vendor/autoload.php';

use Einvoicing\Invoice;
use Einvoicing\InvoiceLine;
use Einvoicing\AllowanceOrCharge;
use Einvoicing\Identifier;
use Einvoicing\Party;
use Einvoicing\Presets;
use Einvoicing\Writers\UblWriter;



$entityBody = file_get_contents('php://input');
$data = json_decode($entityBody);


// Create invoice
$invoice = new Invoice(Presets\CiusRo::class);
$invoice->setNumber($data->metadata->number)
    ->setCurrency($data->metadata->currency)
    ->setIssueDate(new DateTime($data->metadata->issueDate))
    ->setDueDate(new DateTime($data->metadata->dueDate));


// Set seller
$seller_identifier = new Identifier($data->seller->vatNumber);
$seller = new Party();
$seller
    ->setName($data->seller->name)
    ->setAddress([$data->seller->address])
    ->setCity($data->seller->city)
    ->setSubdivision($data->seller->subdivision)
    ->setCountry($data->seller->country);
if ($data->seller->vatPayer) {
    $seller->setVatNumber($data->seller->vatNumber);
} else {
    $seller->setCompanyId($seller_identifier);
}
$invoice->setSeller($seller);


// Set buyer
$buyer_identifier = new Identifier($data->buyer->vatNumber);
$buyer = new Party();
$buyer
    ->setName($data->buyer->name)
    ->setAddress([$data->buyer->address])
    ->setCity($data->buyer->city)
    ->setSubdivision($data->buyer->subdivision)
    ->setCountry($data->buyer->country);
if ($data->buyer->vatPayer) {
    $buyer->setVatNumber($data->buyer->vatNumber);
} else {
    $buyer->setCompanyId($buyer_identifier);
}
$invoice->setBuyer($buyer);


// Add products
foreach ($data->lines as $line) {
    $invoiceLine = new InvoiceLine();
    $invoiceLine->setName($line->name)
        ->setPrice($line->price)
        ->setVatRate($line->vatRate)
        ->setQuantity($line->quantity);

    if (isset($line->allowance)) {
        $allowance = new AllowanceOrCharge();
        $allowance
            ->setAmount($line->allowance->amount)
            ->setReason($line->allowance->reason);
        if ($line->allowance->fixedAmount) {
            $allowance->markAsFixedAmount();
        } else {
            $allowance->markAsPercentage();
        }
        $invoiceLine->addAllowance($allowance);
    }

    $invoice->addLine($invoiceLine);
}



// Export invoice to a UBL document
header('Content-Type: text/xml');
$writer = new UblWriter();
echo $writer->export($invoice);
